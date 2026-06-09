# Requirements Document

## Introduction

This specification covers a comprehensive security audit and test-coverage improvement programme for the GSDC (GS Digital Currency) Sepolia smart contract suite. The project is a Hardhat + TypeScript codebase implementing an EIP-2535 Diamond proxy, an ERC-20 + EIP-3009 token, a per-partner MarginWallet, and 13 specialised facets that together realise an atomic foreign-exchange settlement network on Ethereum.

The work has four sequential goals: (1) document and validate the overall system functionality, (2) audit the codebase for critical security vulnerabilities, (3) measure the current test coverage baseline, and (4) close every gap to reach 100 % lines / branches / functions / statements — going from the current gate of 90/85/90/90 to full coverage — through a combination of targeted unit tests, branch-exercise tests, and property-based tests (PBTs).

All acceptance criteria are written against the Hardhat 2.22 / Solidity 0.8.24 / OpenZeppelin v5 / ethers v6 stack with `solidity-coverage 0.8.13`.

---

## Glossary

- **Diamond**: The EIP-2535 proxy contract at `contracts/Diamond.sol`. Delegate-calls into facets using `msg.sig` lookup.
- **DiamondInit**: One-shot initialiser called via `delegatecall` during `diamondCut`; sets all `DiamondStorage` fields.
- **DiamondStorage**: The single shared storage struct in `LibSettlement` at slot `keccak256("gsdc.settlement.storage.v1")`.
- **GSDCToken**: The ERC-20 + EIP-3009 + EIP-712 token at `contracts/GSDCToken.sol`. Mintable/burnable by its owner (the Diamond after ownership transfer).
- **EIP3009Extension**: Abstract contract implementing `transferWithAuthorization` and `cancelAuthorization` per the Circle USDC reference.
- **MarginWallet**: Per-partner escrow contract. Only the Diamond can call `deposit`; only the owner can call `withdraw`.
- **SettlementExecutorFacet**: Atomic 4-leg settlement fan-out. Two entry points: `executeSettlement` (single oracle signer) and `executeSettlementAggregated` (multi-signer DON).
- **QuoteVerifierFacet**: EIP-712 quote verification. Exposes `verifyAndDecodeQuote` (single-signer) and `verifyAndDecodeAggregatedQuote` (N-of-M DON).
- **TimeLockControllerFacet**: Unified queue/execute dispatcher for all admin parameter changes. Enforces configurable time-lock delay.
- **ComplianceGateFacet**: Partner KYC registration, suspension/reactivation, and corridor authorisation.
- **FloatManagerFacet**: Float reservation accounting (`reserveFloat` / `releaseFloatReservation`).
- **MintBurnAuthorityFacet**: Admin-controlled GSDC mint (`mintFloat`) and burn (`burnFloat`) via the Diamond.
- **MarginSplitterFacet**: Pure BPS margin calculation helper (`calculateMargins`).
- **DisputeResolverFacet**: Minimal dispute logging (`disputeSettlement`); on-chain refund logic deferred to B-13.
- **PausableFacet**: Emergency `pause` / `unpause` gated to admin. Not yet wired into settlement gates (B-16-γ).
- **EventEmitterFacet**: Orchestrator-gated event emission for audit trail.
- **OracleGovernanceFacet**: DON signer whitelist and threshold management (queue-only, time-locked).
- **DiamondCutFacet**: EIP-2535 diamond cut (owner-only). Facet selectors added/replaced/removed here.
- **DiamondLoupeFacet**: EIP-2535 introspection (facets, selectors, supports-interface).
- **LibFloat**: Float reservation arithmetic helpers; uses `DiamondStorage` for state.
- **LibSettlement**: Diamond storage layout and `enforceAdmin` / `enforceOrchestrator` helpers.
- **LibDiamond**: Standard EIP-2535 diamond cut + loupe storage at `LibDiamond.DIAMOND_STORAGE_POSITION`.
- **LibPausable**: Pause state stored at its own keccak slot; read by `PausableFacet`.
- **Corridor**: A named pair of liquidity venues (e.g. `INR_CNH`). Configures active flag, min/max delivery, margin BPS, and settlement window.
- **Settlement**: A single atomic exchange: `lpSource` → Diamond → `lpDest` (delivery) plus three margin legs.
- **EIP-712**: Ethereum typed-data signature standard used for oracle quotes and EIP-3009 authorisations.
- **EIP-3009**: Gas-delegated ERC-20 transfer-with-authorisation. Nonce binds the auth to one `settlementId`.
- **DON**: Decentralised Oracle Network; N-of-M multi-signer mode for `executeSettlementAggregated`.
- **BPS**: Basis points (1/100 of 1 %). Margin fractions expressed as `uint16` BPS out of 10 000.
- **Orchestrator**: The off-chain Settlement Orchestrator backend. Distinct from `admin` per B-14 C3.
- **Admin**: The privileged governance key. Can queue and execute time-locked parameter changes.
- **TimeLock**: Configurable delay (default 48 h prod, 60 s test) between queueing and executing a parameter change.
- **Float**: GSDC balance that a partner has pre-committed but not yet settled. Tracked in `floatReservations`.
- **Settlement Window**: UTC seconds-from-midnight range during which settlements on a corridor are accepted. Supports wrap-around (e.g. 22:00 → 04:00).
- **Wrap-around Window**: A settlement window where `settlementWindowStart > settlementWindowEnd`, meaning the window crosses midnight.
- **PBT**: Property-based test. Generates random inputs to verify invariants rather than fixed examples.
- **viaIR**: Solidity compiler setting enabling the Yul IR pipeline for optimised code generation.

---

## Requirements

### Requirement 1: System Functionality Documentation and Validation

**User Story:** As an auditor or developer, I want to understand the complete on-chain functionality of the GSDC system, so that I can reason about trust boundaries, data flow, and upgrade paths before reviewing security issues.

#### Acceptance Criteria

1. THE Diamond_System SHALL expose all facet selectors through `DiamondLoupeFacet.facetAddresses()` and `facetFunctionSelectors()`, returning a non-empty list for each deployed facet.
2. THE DiamondInit_Contract SHALL initialise `DiamondStorage.admin`, `DiamondStorage.orchestrator`, `DiamondStorage.oracleSigner`, `DiamondStorage.gsdcToken`, `DiamondStorage.tgsTreasuryWallet`, `DiamondStorage.tgsTreasuryMarginWallet`, `DiamondStorage.maxQuoteTTL`, and `DiamondStorage.timeLockDelay` to the values supplied in `InitArgs` during the `diamondCut` call.
3. WHEN `DiamondInit.init` is called with `orchestrator == address(0)`, THE DiamondInit_Contract SHALL set `DiamondStorage.orchestrator` to `DiamondStorage.admin` to preserve backwards compatibility with pre-B-14 fixtures.
4. WHEN `DiamondInit.init` is called with `orchestrator != address(0)`, THE DiamondInit_Contract SHALL set `DiamondStorage.orchestrator` to the provided address rather than to `admin`.
5. THE Diamond_Contract `receive()` function SHALL never revert and SHALL always accept ETH sent directly to it; tests SHALL send a plain ETH transfer and assert the transaction succeeds and the Diamond's ETH balance increases by the sent amount.
6. THE LibSettlement_Storage_Slot SHALL be `keccak256("gsdc.settlement.storage.v1")`, and this value SHALL differ from `LibDiamond.DIAMOND_STORAGE_POSITION` and from `LibPausable`'s storage slot to prevent storage collisions.
7. THE GSDCToken_Contract SHALL be an ERC-20 token with name `"GSDC"` and symbol `"GSDC"`, conforming to the EIP-712 domain `{name: "GSDC", version: "1"}`.
8. THE MarginWallet_Contract SHALL store the `gsdc`, `owner`, and `settlementDiamond` addresses as immutables set at construction time.

---

### Requirement 2: Security Audit — Access Control

**User Story:** As a security auditor, I want every privileged function to be gated behind the correct role check and to revert with a descriptive error for any unauthorised caller, so that no attacker can bypass governance or settlement controls.

#### Acceptance Criteria

1. WHEN any address other than `DiamondStorage.admin` calls an `enforceAdmin`-gated function (including `queueMarginUpdate`, `queueOrchestratorChange`, `queueTimeLockDelayChange`, `executeTimeLockDelayChange`, `executeChange`, `cancelChange`, `configureCorridor`, `registerPartner`, `suspendPartner`, `reactivatePartner`, `addPartnerCorridor`, `mintFloat`, `burnFloat`, `pause`, `unpause`, `queueOracleSignerChange`, `queueOracleSignersChange`), THE Diamond_System SHALL revert with the string `"LibSettlement: not admin"`.
2. WHEN any address other than `DiamondStorage.orchestrator` calls an `enforceOrchestrator`-gated function (`executeSettlement`, `executeSettlementAggregated`, `reserveFloat`, `releaseFloatReservation`), THE Diamond_System SHALL revert with the string `"LibSettlement: not orchestrator"`.
3. THE DiamondCutFacet SHALL allow only the Diamond owner to call `diamondCut`, reverting for all other callers.
4. WHEN any address other than `MarginWallet.settlementDiamond` calls `MarginWallet.deposit`, THE MarginWallet_Contract SHALL revert with `NotSettlementDiamond()`.
5. WHEN any address other than `MarginWallet.owner` calls `MarginWallet.withdraw`, THE MarginWallet_Contract SHALL revert with `NotOwner()`.
6. FOR ALL admin-gated functions listed in criterion 1, THE Test_Suite SHALL include at least one test per function that calls it from a non-admin signer and asserts the revert.
7. FOR ALL orchestrator-gated functions listed in criterion 2, THE Test_Suite SHALL include at least one test per function that calls it from a non-orchestrator signer and asserts the revert.

---

### Requirement 3: Security Audit — Reentrancy Protection

**User Story:** As a security auditor, I want all state-mutating settlement and wallet functions to be protected against reentrancy attacks, so that a malicious partner or token contract cannot re-enter the Diamond and corrupt settlement state.

#### Acceptance Criteria

1. THE SettlementExecutorFacet SHALL mark settlement status as `1` (EXECUTING) in `DiamondStorage.settlements` BEFORE calling any ERC-20 transfer on both `executeSettlement` and `executeSettlementAggregated` entry points, preventing a reentrant call on the same `settlementId` from proceeding. In addition, THE SettlementExecutorFacet SHALL apply `ReentrancyGuard` (via `nonReentrant`) as an independent, additional layer of reentrancy protection on both entry points.
2. THE EIP3009Extension_Contract SHALL mark `_authorizationStates[from][nonce] = true` BEFORE calling `_transfer`, so that a reentrant `transferWithAuthorization` using the same nonce reverts with `AuthorizationAlreadyUsed`.
3. THE MarginWallet_Contract SHALL apply `ReentrancyGuard` to both `deposit` and `withdraw`, reverting any reentrant call into any `nonReentrant`-decorated function within the same transaction.
4. WHEN a ReentrancyAttacker contract attempts to re-enter `executeSettlement` or `executeSettlementAggregated` from within a token callback during settlement, THE SettlementExecutorFacet SHALL revert the inner call with `SettlementAlreadyExecuted`.
5. WHEN a ReentrancyAttacker contract attempts to re-enter `MarginWallet.withdraw` from within a token callback during withdrawal, THE MarginWallet_Contract SHALL revert the inner call with `ReentrancyGuardReentrantCall()`.

---

### Requirement 4: Security Audit — EIP-712 Signature Integrity

**User Story:** As a security auditor, I want oracle quote signatures to be unforgeable and non-replayable across chains, contracts, and sessions, so that no attacker can substitute a fraudulent quote or replay a stale one.

#### Acceptance Criteria

1. THE QuoteVerifierFacet SHALL include `chainId` and the Diamond proxy address (resolved as `address(this)` at call time because facets are called via `delegatecall`) in the EIP-712 domain separator, so that signatures produced on one chain or contract cannot verify on another.
2. WHEN `QuoteVerifierFacet.verifyAndDecodeQuote` is called with a signature produced by a key that is not `DiamondStorage.oracleSigner`, THE QuoteVerifierFacet SHALL revert with `InvalidOracleSignature()`.
3. WHEN `QuoteVerifierFacet.verifyAndDecodeAggregatedQuote` is called with fewer signatures than `DiamondStorage.oracleThreshold`, THE QuoteVerifierFacet SHALL revert with `BelowThreshold(provided, required)`.
4. WHEN `QuoteVerifierFacet.verifyAndDecodeAggregatedQuote` is called with two signatures from the same signer, THE QuoteVerifierFacet SHALL revert with `DuplicateSigner(signer)`.
5. WHEN `QuoteVerifierFacet.verifyAndDecodeQuote` is called with an encoded quote whose `validBefore <= block.timestamp`, THE QuoteVerifierFacet SHALL revert with `QuoteExpired(quoteId, validBefore)`.
6. WHEN `QuoteVerifierFacet.verifyAndDecodeQuote` is called with an encoded quote whose `validAfter >= block.timestamp`, THE QuoteVerifierFacet SHALL revert with `QuoteNotYetValid(quoteId, validAfter)`.
7. THE `ORACLE_QUOTE_TYPEHASH` constant in `QuoteVerifierFacet` SHALL include the `isOverridden` field, so that any change to the `isOverridden` flag invalidates an existing signature.
8. THE `ORACLE_QUOTE_AGGREGATED_TYPEHASH` constant SHALL differ from `ORACLE_QUOTE_TYPEHASH` and SHALL include the `reportsRoot` field.
9. WHEN `SettlementExecutorFacet.executeSettlement` is called with a `deliveryAmount` that differs from the value signed inside the verified oracle quote, THE SettlementExecutorFacet SHALL revert with `DeliveryAmountMismatch(supplied, signed)`.
10. WHEN `SettlementExecutorFacet.executeSettlement` is called with a `quoteId` or `corridorId` that does not match the verified quote, THE SettlementExecutorFacet SHALL revert with `QuoteCorridorMismatch()`.
11. WHEN `QuoteVerifierFacet.verifyAndDecodeQuote` is called with a valid `OracleQuote` signed by the oracle key, THE QuoteVerifierFacet SHALL return the decoded quote without reverting; WHEN it is called with the same `OracleQuote` signed by any other key, THE QuoteVerifierFacet SHALL revert with `InvalidOracleSignature()`.
12. WHEN `QuoteVerifierFacet.verifyAndDecodeAggregatedQuote` is called with an encoded quote whose `validBefore <= block.timestamp` or `validAfter >= block.timestamp`, THE QuoteVerifierFacet SHALL revert with `QuoteExpired` or `QuoteNotYetValid` respectively, using the same time-validity enforcement as `verifyAndDecodeQuote`.

---

### Requirement 5: Security Audit — EIP-3009 Transfer Authorization Integrity

**User Story:** As a security auditor, I want EIP-3009 transfer authorizations to be single-use and correctly bound to their settlement, so that a replayed, expired, or cross-settlement authorization cannot drain a partner's float.

#### Acceptance Criteria

1. WHEN `GSDCToken.transferWithAuthorization` is called a second time with the same `(from, nonce)` pair, THE GSDCToken_Contract SHALL revert with `AuthorizationAlreadyUsed(authorizer, nonce)`.
2. WHEN `GSDCToken.transferWithAuthorization` is called with `block.timestamp >= validBefore`, THE GSDCToken_Contract SHALL revert with `AuthorizationExpired(validBefore, currentTime)`.
3. WHEN `GSDCToken.transferWithAuthorization` is called with `block.timestamp <= validAfter`, THE GSDCToken_Contract SHALL revert with `AuthorizationNotYetValid(validAfter, currentTime)`.
4. WHEN `SettlementExecutorFacet._redeemAuthorization` is called with an `authorizationSig` that is not exactly 97 bytes, THE SettlementExecutorFacet SHALL revert with `InvalidAuthorizationSig()`.
5. WHEN a valid EIP-3009 authorization for `settlementId = S` is used inside `executeSettlement` for settlement `S`, THE Test_Suite SHALL verify that re-using the same authorization for a different settlement `S'` reverts with `AuthorizationAlreadyUsed` (cross-settlement replay).
6. WHEN `SettlementExecutorFacet.executeSettlement` is called with an EIP-3009 authorization whose `validBefore` has already passed (EVM time-warped past it), THE SettlementExecutorFacet SHALL revert, propagating `AuthorizationExpired` from the GSDC token.
7. WHEN `GSDCToken.cancelAuthorization` is called with a valid authorizer signature, THE GSDCToken_Contract SHALL mark the nonce as used and emit `AuthorizationCanceled`, preventing subsequent `transferWithAuthorization` calls with the same nonce from succeeding.
8. FOR ALL valid `(from, to, value, validAfter, validBefore, nonce)` tuples, THE Test_Suite SHALL verify that a signature produced with `signEIP3009Authorization()` is accepted by `transferWithAuthorization()` and that a signature produced by any other key is rejected (round-trip property).

---

### Requirement 6: Security Audit — Time-Lock and Governance Integrity

**User Story:** As a security auditor, I want all admin parameter changes to be gated by a mandatory time delay and to be impossible to execute before the delay elapses, so that users have a window to react to malicious governance actions.

#### Acceptance Criteria

1. WHEN `TimeLockControllerFacet.executeChange` is called before `block.timestamp >= pendingChanges[changeId]`, THE TimeLockControllerFacet SHALL revert with `ChangeNotReady(changeId, readyAt)`; THE Test_Suite SHALL assert test success when the revert is correctly detected (the test passes when the revert occurs as expected).
2. WHEN `TimeLockControllerFacet.executeChange` is called with a `changeId` that was never queued (`pendingChanges[changeId] == 0`), THE TimeLockControllerFacet SHALL revert with `ChangeNotFound(changeId)`.
3. WHEN `TimeLockControllerFacet.executeChange` is called with a `changeId` whose stored `kind` does not match any of `KIND_MARGIN`, `KIND_ORCHESTRATOR`, `KIND_ORACLE_SIGNER`, `KIND_ORACLE_SIGNERS`, or `bytes32(0)` (legacy-margin shim), THE TimeLockControllerFacet SHALL revert with `UnknownKind(kind)`.
4. WHEN `TimeLockControllerFacet.queueTimeLockDelayChange` queues a new delay and `executeTimeLockDelayChange` is called before the current delay has elapsed, THE TimeLockControllerFacet SHALL revert with `DelayChangeNotReady(readyAt)`.
5. WHEN `TimeLockControllerFacet.executeTimeLockDelayChange` is called when no delay change has been queued, THE TimeLockControllerFacet SHALL revert with `DelayChangeNotFound()`.
6. WHEN `TimeLockControllerFacet.cancelChange` is called with a valid `changeId`, THE TimeLockControllerFacet SHALL delete the pending change and emit `ChangeCancelled`, making any subsequent `executeChange` call with that `changeId` revert with `ChangeNotFound`.
7. WHEN `TimeLockControllerFacet.queueMarginUpdate` is called and then `executeChange` is called after the delay, THE TimeLockControllerFacet SHALL update `lpSourceMarginBps`, `tgsTreasuryMarginBps`, and `lpDestMarginBps` on the corridor and emit `ChangeExecuted`.
8. WHEN `TimeLockControllerFacet.executeChange` is called with a margin update where `lpSourceBps + tgsTreasuryBps + lpDestBps > 10 000`, THE TimeLockControllerFacet SHALL revert with `MarginBpsSumExceedsMax(sum)`.

---

### Requirement 7: Security Audit — Settlement State Machine and Corridor Guards

**User Story:** As a security auditor, I want the settlement execution to enforce corridor constraints and a linear state machine, so that settlements cannot be executed twice, outside a configured window, on inactive corridors, or with invalid partners.

#### Acceptance Criteria

1. WHEN `SettlementExecutorFacet.executeSettlement` is called with a `settlementId` whose `DiamondStorage.settlements[settlementId].status != 0`, THE SettlementExecutorFacet SHALL revert with `SettlementAlreadyExecuted(settlementId)`.
2. WHEN `SettlementExecutorFacet.executeSettlement` is called with a `corridorId` whose `CorridorConfig.active == false`, THE SettlementExecutorFacet SHALL revert with `CorridorNotActive(corridorId)`.
3. WHEN `SettlementExecutorFacet.executeSettlement` is called with `deliveryAmount < CorridorConfig.minDeliveryAmount`, THE SettlementExecutorFacet SHALL revert with `AmountBelowMinimum(amount, minimum)`.
4. WHEN `SettlementExecutorFacet.executeSettlement` is called with `deliveryAmount > CorridorConfig.maxDeliveryAmount` and `maxDeliveryAmount != 0`, THE SettlementExecutorFacet SHALL revert with `AmountAboveMaximum(amount, maximum)`.
5. WHEN `SettlementExecutorFacet._enforceWindow` is called with a timestamp (seconds-from-midnight) satisfying `sec < settlementWindowStart` OR `sec > settlementWindowEnd` on a non-wrap-around window (i.e. `start <= end`), THE SettlementExecutorFacet SHALL revert with `OutsideSettlementWindow(0)`.
6. WHEN `SettlementExecutorFacet._enforceWindow` is called with a timestamp satisfying `sec < settlementWindowStart AND sec > settlementWindowEnd` on a wrap-around window (i.e. `start > end`), THE SettlementExecutorFacet SHALL revert with `OutsideSettlementWindow(0)`.
7. WHEN `SettlementExecutorFacet._enforceWindow` is called with a timestamp satisfying `sec >= settlementWindowStart OR sec <= settlementWindowEnd` on a wrap-around window (i.e. `start > end`), THE SettlementExecutorFacet SHALL NOT revert, allowing the settlement to proceed to the next gate.
8. WHEN `SettlementExecutorFacet.executeSettlement` is called with an `lpSource` that is not registered or not authorised on the `corridorId`, THE SettlementExecutorFacet SHALL revert with `PartnerNotAuthorised(partner, corridorId)`.
9. WHEN `SettlementExecutorFacet.executeSettlement` is called with an `lpDest` that is not registered or not authorised on the `corridorId`, THE SettlementExecutorFacet SHALL revert with `PartnerNotAuthorised(partner, corridorId)`.
10. WHEN `SettlementExecutorFacet.executeSettlementAggregated` is called with a timestamp satisfying the outside-window condition for the corridor (non-wrap-around: `sec < start OR sec > end`; wrap-around: `sec < start AND sec > end`), THE SettlementExecutorFacet SHALL revert with `OutsideSettlementWindow(0)`.
11. WHEN `SettlementExecutorFacet.executeSettlementAggregated` is called with a timestamp inside a wrap-around window (i.e. `sec >= start OR sec <= end`), THE SettlementExecutorFacet SHALL proceed past the window gate.
12. AFTER a successful `executeSettlement` call, THE SettlementExecutorFacet SHALL have written a `Settlement` record with `status == 2` (SETTLED, transitioning from the transient `1` EXECUTING state within the call), the correct `deliveryAmount`, `totalDebit == deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin`, where each margin equals `deliveryAmount * bps / 10_000`, `corridorId`, `lpSource`, `lpDest`, and a non-zero `settledAt`.
13. WHEN `SettlementExecutorFacet.executeSettlement` or `SettlementExecutorFacet.executeSettlementAggregated` is called by any address other than `DiamondStorage.orchestrator`, THE SettlementExecutorFacet SHALL revert with `"LibSettlement: not orchestrator"`.

---

### Requirement 8: Security Audit — Float Reservation Integrity

**User Story:** As a security auditor, I want float reservations to prevent over-commitment of a partner's balance and to release atomically, so that settlement races or double-reserves cannot drain the system.

#### Acceptance Criteria

1. WHEN `FloatManagerFacet.reserveFloat` is called with an `amount` exceeding the partner's available float (balance minus existing reservations), THE FloatManagerFacet SHALL revert with `InsufficientFloat(partner, available, required)` via `LibFloat.reserve`.
2. WHEN `FloatManagerFacet.reserveFloat` is called a second time with the same `settlementId`, THE FloatManagerFacet SHALL revert with `ReservationAlreadyExists(settlementId)`.
3. WHEN `FloatManagerFacet.releaseFloatReservation` is called for a `settlementId` with no existing reservation (`settlementReservations[settlementId] == 0`), THE FloatManagerFacet SHALL complete without reverting and emit `FloatReleased` with `amount == 0` (idempotent path).
4. WHEN `LibFloat.reserve` is called with `available == amount` (exact boundary), THE LibFloat_Library SHALL succeed and increase `floatReservations[partner]` by exactly `amount`.
5. WHEN `LibFloat.reserve` is called with `available == amount - 1` (one unit below the boundary), THE LibFloat_Library SHALL revert with `InsufficientFloat`.
6. AFTER `LibFloat.release` is called for a valid reservation of `R` tokens, THE LibFloat_Library SHALL decrease `floatReservations[partner]` by exactly `R` and delete `settlementReservations[settlementId]`.
7. WHEN `LibFloat.release` is called twice for the same `settlementId`, THE LibFloat_Library SHALL execute the second call as a no-op, leaving `floatReservations[partner]` unchanged from its post-first-release value (idempotence property).

---

### Requirement 9: Security Audit — Compliance and Partner Registration

**User Story:** As a security auditor, I want partner compliance checks to correctly identify suspended and unregistered partners, so that KYC-failed or suspended counterparties cannot participate in settlements.

#### Acceptance Criteria

1. WHEN `ComplianceGateFacet.checkCompliance` is called for a partner whose `PartnerConfig.active == false` (suspended), THE ComplianceGateFacet SHALL revert with `PartnerSuspended_(partner)`.
2. WHEN `ComplianceGateFacet.checkCompliance` is called for an address that was never registered (`kycHash == bytes32(0)`), THE ComplianceGateFacet SHALL revert with `PartnerNotAuthorised(partner, corridorId)`.
3. WHEN `ComplianceGateFacet.checkCompliance` is called for a registered partner who is not authorised on the given `corridorId`, THE ComplianceGateFacet SHALL revert with `PartnerNotAuthorised(partner, corridorId)`.
4. WHEN `ComplianceGateFacet.registerPartner` is called for an address that already has a non-zero `kycHash`, THE ComplianceGateFacet SHALL revert with `PartnerAlreadyRegistered(partner)`.

---

### Requirement 10: Security Audit — Mint/Burn Authority

**User Story:** As a security auditor, I want GSDC minting and burning to be exclusively accessible through the admin-gated Diamond facet, so that no actor other than the Diamond admin can inflate or deflate token supply.

#### Acceptance Criteria

1. WHEN `MintBurnAuthorityFacet.mintFloat` is called by the admin, THE MintBurnAuthorityFacet SHALL call `IGSDCMintBurn(gsdcToken).mint(to, amount)`, increasing `to`'s balance by `amount`, and emit `FloatMinted(to, amount, actor)`.
2. WHEN `MintBurnAuthorityFacet.burnFloat` is called by the admin, THE MintBurnAuthorityFacet SHALL call `IGSDCMintBurn(gsdcToken).burn(from, amount)`, decreasing `from`'s balance by `amount`, and emit `FloatBurned(from, amount, actor)`.
3. WHEN `MintBurnAuthorityFacet.mintFloat` is called by a non-admin address, THE MintBurnAuthorityFacet SHALL revert with `"LibSettlement: not admin"`.
4. WHEN `MintBurnAuthorityFacet.burnFloat` is called by a non-admin address, THE MintBurnAuthorityFacet SHALL revert with `"LibSettlement: not admin"`.
5. WHEN `GSDCToken.mint` is called by any address other than the token's `owner` (the Diamond after ownership transfer), THE GSDCToken_Contract SHALL revert with the OZ `OwnableUnauthorizedAccount` error.
6. WHEN `GSDCToken.burn` is called by any address other than the token's `owner`, THE GSDCToken_Contract SHALL revert with the OZ `OwnableUnauthorizedAccount` error.

---

### Requirement 11: Security Audit — Pause Mechanism

**User Story:** As a security auditor, I want the emergency pause and unpause functions to protect against double-toggling and to be accessible only by the admin, so that the pause state is well-defined and cannot be entered erroneously.

#### Acceptance Criteria

1. WHEN `PausableFacet.pause` is called by the admin while the system is not paused, THE PausableFacet SHALL set `LibPausable.PausableStorage.paused = true` and emit `Paused(actor, pausedAt)`.
2. WHEN `PausableFacet.pause` is called while the system is already paused, THE PausableFacet SHALL revert with `AlreadyPaused()`.
3. WHEN `PausableFacet.unpause` is called by the admin while the system is paused, THE PausableFacet SHALL set `LibPausable.PausableStorage.paused = false` and emit `Unpaused(actor, unpausedAt)`.
4. WHEN `PausableFacet.unpause` is called while the system is not paused, THE PausableFacet SHALL revert with `NotPaused()`.
5. WHEN `PausableFacet.pause` is called by a non-admin address, THE PausableFacet SHALL revert with `"LibSettlement: not admin"`.
6. WHEN `PausableFacet.unpause` is called by a non-admin address, THE PausableFacet SHALL revert with `"LibSettlement: not admin"`.
7. AFTER `PausableFacet.pause` is called, `PausableFacet.isPaused()` SHALL return `true`. AFTER `PausableFacet.unpause` is called, `PausableFacet.isPaused()` SHALL return `false`.

---

### Requirement 12: Security Audit — Oracle Governance Integrity

**User Story:** As a security auditor, I want oracle signer rotation to be time-locked and validated at queue time, so that malicious or duplicate signers cannot be added without the governance delay.

#### Acceptance Criteria

1. WHEN `OracleGovernanceFacet.queueOracleSignersChange` is called with a `threshold < 1`, THE OracleGovernanceFacet SHALL revert with `ThresholdBelowOne()`.
2. WHEN `OracleGovernanceFacet.queueOracleSignersChange` is called with more than 10 signers, THE OracleGovernanceFacet SHALL revert with `TooManySigners()`.
3. WHEN `OracleGovernanceFacet.queueOracleSignersChange` is called with `signers.length < threshold`, THE OracleGovernanceFacet SHALL revert with `SignersBelowThreshold()`.
4. WHEN `OracleGovernanceFacet.queueOracleSignersChange` is called with a duplicate address in the `signers` array, THE OracleGovernanceFacet SHALL revert with `DuplicateSignerInList(signer)`.
5. WHEN `OracleGovernanceFacet.queueOracleSignersChange` is called with `address(0)` in the `signers` array, THE OracleGovernanceFacet SHALL revert with `ZeroSigner()`.
6. WHEN `QuoteVerifierFacet.queueOracleSignerChange` is called by a non-admin address, THE QuoteVerifierFacet SHALL revert with `"LibSettlement: not admin"`.
7. AFTER `queueOracleSignerChange` is executed via `TimeLockControllerFacet.executeChange`, THE DiamondStorage SHALL have updated `oracleSigner` to the new address, and subsequent `verifyAndDecodeQuote` calls signed by the new key SHALL succeed.

---

### Requirement 13: Security Audit — Margin Calculation Integrity

**User Story:** As a security auditor, I want margin calculations to revert on unconfigured corridors and to be bounded so that BPS arithmetic never silently produces incorrect margins.

#### Acceptance Criteria

1. WHEN `MarginSplitterFacet.calculateMargins` is called with a `corridorId` whose `CorridorConfig.active == false`, THE MarginSplitterFacet SHALL revert with `CorridorNotConfigured(corridorId)`.
2. WHEN `MarginSplitterFacet.calculateMargins` is called with a `corridorId` that was never configured (all fields zero-default), THE MarginSplitterFacet SHALL revert with `CorridorNotConfigured(corridorId)`.
3. WHEN `MarginSplitterFacet.calculateMargins` is called with a valid active corridor and `deliveryAmount = 10 000 000`, THE MarginSplitterFacet SHALL return the correct three-way split: `lpSourceMargin = deliveryAmount * lpSourceBps / 10000`, `tgsTreasuryMargin = deliveryAmount * tgsTreasuryBps / 10000`, `lpDestMargin = deliveryAmount * lpDestBps / 10000`.

---

### Requirement 14: Security Audit — Dispute Resolution Guards

**User Story:** As a security auditor, I want the dispute resolver to reject disputes on non-existent settlements, so that the audit trail cannot be polluted with phantom entries.

#### Acceptance Criteria

1. WHEN `DisputeResolverFacet.disputeSettlement` is called with a `settlementId` for which `DiamondStorage.settlements[settlementId].status == 0` (never executed), THE DisputeResolverFacet SHALL revert with `SettlementNotFound(settlementId)`.
2. WHEN `DisputeResolverFacet.disputeSettlement` is called with a `settlementId` for a previously executed (status == 2) settlement, THE DisputeResolverFacet SHALL emit `SettlementDisputed(settlementId, disputant, reason)` without reverting.

---

### Requirement 15: Test Coverage — Coverage Baseline Measurement

**User Story:** As a developer, I want to measure the current test coverage before making changes, so that I can track progress toward the 100 % target and identify which specific lines/branches/functions/statements need new tests.

#### Acceptance Criteria

1. THE Test_Suite SHALL produce a `solidity-coverage` report showing per-contract and aggregate line, branch, function, and statement coverage percentages when `npx hardhat coverage` is run; the report SHALL only be generated when there is at least a minimum baseline of existing tests passing to ensure the report reflects a meaningful starting state.
2. THE Coverage_Report SHALL identify all uncovered lines, branches, and functions in each of the 13 facets, `GSDCToken`, `EIP3009Extension`, `MarginWallet`, `Diamond`, `DiamondInit`, `LibFloat`, `LibSettlement`, `LibPausable`, and `LibDiamond`.
3. THE Coverage_Threshold_Configuration in `.solcover.js` SHALL specify a coverage gate of at least 100 lines / 100 branches / 100 functions / 100 statements as the target.

---

### Requirement 16: Test Coverage — PausableFacet Full Coverage

**User Story:** As a developer, I want `PausableFacet` to be fully covered, so that the emergency stop mechanism is verified to work correctly and the coverage report does not flag it as untested.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `pause()` from the admin, verifies `isPaused()` returns `true`, and confirms `Paused` was emitted.
2. THE Test_Suite SHALL include a test that calls `unpause()` after `pause()`, verifies `isPaused()` returns `false`, and confirms `Unpaused` was emitted.
3. THE Test_Suite SHALL include a test that calls `pause()` twice and asserts the second call reverts with `AlreadyPaused()`.
4. THE Test_Suite SHALL include a test that calls `unpause()` on an unpaused system and asserts it reverts with `NotPaused()`.
5. THE Test_Suite SHALL include a test that calls `pause()` from a non-admin signer and asserts it reverts with `"LibSettlement: not admin"`.
6. THE Test_Suite SHALL include a test that calls `unpause()` from a non-admin signer (after pausing via admin) and asserts it reverts with `"LibSettlement: not admin"`.
7. THE PausableFacet_Tests SHALL include `PausableFacet` in the Diamond's facet cut list so that calls are routed through the Diamond proxy.

---

### Requirement 17: Test Coverage — FloatManagerFacet Full Coverage

**User Story:** As a developer, I want all branches of `FloatManagerFacet` and `LibFloat` to be covered, so that float accounting edge cases are verified and the coverage report reaches 100 %.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `reserveFloat` where the partner's balance is exactly equal to the `amount` requested, asserting the call succeeds (exact-boundary success path of `LibFloat.reserve`).
2. THE Test_Suite SHALL include a test that calls `reserveFloat` where the partner's available float is `amount - 1`, asserting it reverts with `InsufficientFloat` (exact-boundary failure path).
3. THE Test_Suite SHALL include a test that calls `reserveFloat` twice with the same `settlementId`, asserting the second call reverts with `ReservationAlreadyExists(settlementId)`.
4. THE Test_Suite SHALL include a test that calls `releaseFloatReservation` for a `settlementId` that was never reserved, asserting the call completes without reverting and emits `FloatReleased` with `amount == 0`.
5. THE Test_Suite SHALL include a test that calls `releaseFloatReservation` twice for the same `settlementId`, asserting the second call is a no-op with `floatReservations[partner]` unchanged (idempotence).
6. THE Test_Suite SHALL include a test that calls `reserveFloat` from a non-orchestrator signer and asserts it reverts with `"LibSettlement: not orchestrator"`.

---

### Requirement 18: Test Coverage — SettlementExecutorFacet Wrap-Around Window Coverage

**User Story:** As a developer, I want the wrap-around settlement window logic in `SettlementExecutorFacet._enforceWindow` to be fully branch-covered for both the single-signer and aggregated entry points, so that the midnight-crossing time window functions correctly.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that configures a wrap-around window (e.g. `start=79200`, `end=14400`), sets `block.timestamp` to a value whose `% 86400` falls INSIDE the window (e.g. second `82800`, which is 23:00), and asserts `executeSettlement` does not revert on the window gate.
2. THE Test_Suite SHALL include a test that configures a wrap-around window (e.g. `start=79200`, `end=14400`), sets `block.timestamp` to a value whose `% 86400` falls OUTSIDE the window (e.g. second `43200`, which is 12:00), and asserts `executeSettlement` reverts with `OutsideSettlementWindow`; the test must exist AND correctly verify the revert behavior.
3. THE Test_Suite SHALL include a test equivalent to criteria 1 and 2 for `executeSettlementAggregated`, covering the wrap-around inside and outside branches on the aggregated entry point.
4. THE Test_Suite SHALL use `evm_setNextBlockTimestamp` to precisely control the `block.timestamp % 86400` value in all window branch tests; this time control SHALL be applied only within the context of each window branch test.

5. FOR ALL settlement window tests, THE Test_Suite SHALL verify the expected revert or success outcome specifically from the window enforcement gate, distinguishing it from other pre-window reverts (e.g. inactive corridor, unregistered partner) through appropriate test setup order.

---

### Requirement 19: Test Coverage — TimeLockControllerFacet UnknownKind and ChangeNotReady Coverage

**User Story:** As a developer, I want the `UnknownKind` and `ChangeNotReady` branches in `TimeLockControllerFacet.executeChange` to be covered, so that the dispatcher's error paths are verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that queues a change and calls `executeChange` immediately (without advancing EVM time past `readyAt`), asserting it reverts with `ChangeNotReady(changeId, readyAt)`; the test must exist and work correctly.
2. THE Test_Suite SHALL include a test that injects a `changeId` into `pendingChanges` and `pendingChangeKinds` with a `kind` value that does not match any of the four `KIND_*` constants and is not `bytes32(0)`, then calls `executeChange`, asserting it reverts with `UnknownKind(kind)`; the test must exist and work correctly, and a passing test result indicates the revert was correctly detected.
3. IF the `UnknownKind` branch requires direct storage manipulation (via `hardhat_setStorageAt` or a test-only shim facet), THE Test_Suite SHALL document the mechanism used to reach this branch.

---

### Requirement 20: Test Coverage — ComplianceGateFacet Full Branch Coverage

**User Story:** As a developer, I want all three revert branches in `ComplianceGateFacet.checkCompliance` to be covered, so that partner compliance enforcement is fully verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that registers a partner, suspends them via `suspendPartner`, then calls `checkCompliance`, asserting it reverts with `PartnerSuspended_(partner)`.
2. THE Test_Suite SHALL include a test that calls `checkCompliance` on an address that was never registered (zero `kycHash`), asserting it reverts with `PartnerNotAuthorised(partner, corridorId)`.
3. THE Test_Suite SHALL include a test that registers a partner without the target corridor, then calls `checkCompliance` with that corridor, asserting it reverts with `PartnerNotAuthorised(partner, corridorId)`.

---

### Requirement 21: Test Coverage — DisputeResolverFacet SettlementNotFound Coverage

**User Story:** As a developer, I want the `SettlementNotFound` revert branch in `DisputeResolverFacet.disputeSettlement` to be covered so that the dispute guard is verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `disputeSettlement` with a `settlementId` that has never been executed, asserting it reverts with `SettlementNotFound(settlementId)`; the test must exist AND its assertion must pass when executed.

---

### Requirement 22: Test Coverage — MintBurnAuthorityFacet burnFloat Coverage

**User Story:** As a developer, I want `MintBurnAuthorityFacet.burnFloat` and its non-admin revert paths to be covered, so that the burn authority function is verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that mints tokens to an address via `mintFloat`, then burns them via `burnFloat`, asserting the target address's final balance is zero and `FloatBurned` was emitted.
2. THE Test_Suite SHALL include a test that calls `burnFloat` from a non-admin signer, asserting it reverts with `"LibSettlement: not admin"`.
3. THE Test_Suite SHALL include a test that calls `mintFloat` from a non-admin signer, asserting it reverts with `"LibSettlement: not admin"`.

---

### Requirement 23: Test Coverage — DiamondInit Both Orchestrator Branches

**User Story:** As a developer, I want both branches of the orchestrator initialisation logic in `DiamondInit.init` to be covered, so that the backwards-compatibility fallback and the distinct-address path are both verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL always include a test that deploys a fresh Diamond and calls `init` with `orchestrator == address(0)`, then reads back `DiamondStorage.orchestrator` via `enforceOrchestrator` (or a view helper), asserting it equals `admin`.
2. THE Test_Suite SHALL always include a test that deploys a fresh Diamond and calls `init` with a distinct `orchestrator != address(0)`, then asserts that orchestrator-gated functions succeed when called by that address and fail when called by `admin`.

---

### Requirement 24: Test Coverage — Diamond ETH Receive Fallback

**User Story:** As a developer, I want the `Diamond.receive()` function to be covered so that the contract's ability to accept ETH is verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that sends ETH directly to the Diamond address using `ethers.provider.sendTransaction` (or equivalent), asserting the transaction succeeds and the Diamond's ETH balance increases by the sent amount; the test SHALL also verify the balance change numerically to confirm correct accounting.

---

### Requirement 25: Test Coverage — MarginSplitterFacet Inactive Corridor Revert

**User Story:** As a developer, I want the `CorridorNotConfigured` revert path in `MarginSplitterFacet.calculateMargins` to be covered so that the guard against unconfigured corridors is verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `calculateMargins` with a `corridorId` that was never configured (default inactive), asserting it reverts with `CorridorNotConfigured(corridorId)`.
2. THE Test_Suite SHALL include a test that configures a corridor as active, then deactivates it by calling `configureCorridor` with `active == false`, then calls `calculateMargins`, asserting it reverts with `CorridorNotConfigured(corridorId)`.

---

### Requirement 26: Test Coverage — QuoteVerifierFacet Non-Admin and Post-Rotation Coverage

**User Story:** As a developer, I want `queueOracleSignerChange`'s non-admin path and the `oracleSigner` post-rotation state to be covered so that the time-locked rotation flow is fully verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `queueOracleSignerChange` from a non-admin signer, asserting it reverts with `"LibSettlement: not admin"`.
2. THE Test_Suite SHALL include a test that calls `queueOracleSignerChange` from admin, advances time past `timeLockDelay`, calls `executeChange`, and then reads `DiamondStorage.oracleSigner`, asserting it equals the new signer address.
3. THE Test_Suite SHALL include a test that, after a successful signer rotation, calls `verifyAndDecodeQuote` with a quote signed by the NEW signer key and asserts it succeeds, then calls it with the OLD signer key and asserts it reverts with `InvalidOracleSignature`; these verification assertions SHALL always be enforced regardless of whether rotation completion was explicitly confirmed in a prior assertion.

---

### Requirement 27: Test Coverage — EIP-3009 AuthorizationExpired Within Settlement Flow

**User Story:** As a developer, I want the `AuthorizationExpired` propagation path from `_redeemAuthorization` within `SettlementExecutorFacet.executeSettlement` to be covered, so that the settlement-level expiry enforcement is verified.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that builds an EIP-3009 authorization with a `validBefore` in the near future, advances EVM time past that `validBefore`, then calls `executeSettlement` with all other parameters valid, asserting it reverts (propagating `AuthorizationExpired` from the GSDC token).
2. THE Test_Suite SHALL use `evm_increaseTime` or `evm_setNextBlockTimestamp` to advance the EVM clock past the `validBefore` timestamp before submitting the settlement call; this time manipulation SHALL be scoped only to this specific authorization expiry test and SHALL be reverted (or compensated) before subsequent tests in the same suite.

---

### Requirement 28: Property-Based Testing — Margin BPS Sum Invariant

**User Story:** As a developer, I want a property-based test to verify that `TimeLockControllerFacet.executeChange` always rejects margin BPS configurations where the sum exceeds 10 000, so that the on-chain guard is exhaustively validated across the entire input space.

#### Acceptance Criteria

1. THE Property_Test SHALL generate random `(lpSourceBps, tgsTreasuryBps, lpDestBps)` triples drawn from `uint16` space (0–65 535 each).
2. WHEN the sum `lpSourceBps + tgsTreasuryBps + lpDestBps > 10 000`, THE Property_Test SHALL assert that `executeChange` reverts with `MarginBpsSumExceedsMax`.
3. WHEN the sum `lpSourceBps + tgsTreasuryBps + lpDestBps <= 10 000`, THE Property_Test SHALL assert that `executeChange` succeeds and the corridor's stored BPS values match the queued inputs.
4. THE Property_Test SHALL run at least 200 iterations covering boundary inputs including `(0, 0, 0)`, `(3333, 3334, 3333)` (sum = 10 000 exactly), and `(10000, 1, 0)` (sum = 10 001).

---

### Requirement 29: Property-Based Testing — Float Reservation Arithmetic Invariants

**User Story:** As a developer, I want property-based tests to verify that float reservation arithmetic maintains monotonic and idempotent invariants regardless of input values, so that the accounting library is exhaustively validated.

#### Acceptance Criteria

1. THE Property_Test SHALL generate random `(balance, reserveAmount)` pairs where `balance >= reserveAmount > 0` and verify that after `reserve(partner, settlementId, reserveAmount, balance)`, `floatReservations[partner]` increases by exactly `reserveAmount`.
2. THE Property_Test SHALL generate random `(balance, reserveAmount)` pairs where `balance < reserveAmount` and verify that `reserve` reverts with `InsufficientFloat`.
3. THE Property_Test SHALL verify that after a successful `reserve` followed by `release`, `floatReservations[partner]` returns to its pre-reserve value (round-trip invariant).
4. THE Property_Test SHALL verify that calling `release` twice for the same `settlementId` produces the same `floatReservations[partner]` as calling it once (idempotence property: `release(release(x)) == release(x)`).
5. THE Property_Test SHALL run at least 200 iterations with randomly generated balances and amounts in the range `[1, 10^27]`.

---

### Requirement 30: Property-Based Testing — Settlement State Machine Transition Invariants

**User Story:** As a developer, I want property-based tests to verify that the settlement state machine only transitions forward and that completed settlements are permanently locked, so that the atomicity guarantee is exhaustively validated.

#### Acceptance Criteria

1. THE Property_Test SHALL generate random valid settlement inputs (varied `deliveryAmount`, `quoteId`, `corridorId`, partners) and verify that after a successful `executeSettlement` call, the `Settlement.status` is always exactly `2` (SETTLED).
2. THE Property_Test SHALL verify that for any `settlementId` that has been successfully executed (status == 2), a subsequent `executeSettlement` call with the same `settlementId` (any other parameters) always reverts with `SettlementAlreadyExecuted`.
3. THE Property_Test SHALL verify that `Settlement.settledAt >= Settlement.createdAt` for all executed settlements.
4. THE Property_Test SHALL verify that `Settlement.totalDebit == Settlement.deliveryAmount + Settlement.lpSourceMargin + Settlement.tgsTreasuryMargin + Settlement.lpDestMargin` for all executed settlements.
5. THE Property_Test SHALL run at least 100 iterations with varied `deliveryAmount` values to confirm margin arithmetic is consistent across amounts.

---

### Requirement 31: Property-Based Testing — EIP-712 Domain Separator Stability

**User Story:** As a developer, I want a property-based test to verify that the EIP-712 domain separator is stable and that the round-trip signing workflow is correct for all valid quote inputs, so that typehash drift and cross-chain replay are prevented by design.

#### Acceptance Criteria

1. THE Property_Test SHALL call `QuoteVerifierFacet.quoteDomainSeparator()` multiple times (across different blocks) and verify the returned value is identical each time the chain ID and Diamond address are unchanged.
2. THE Property_Test SHALL generate random `OracleQuote` structs with varied field values and verify that a signature produced by `buildSignedQuote()` with the oracle private key always passes `verifyAndDecodeQuote()`.
3. THE Property_Test SHALL verify that a signature produced by `buildSignedQuote()` for one Diamond address always fails `verifyAndDecodeQuote()` on a different Diamond address (cross-contract replay).
4. THE Property_Test SHALL run at least 100 iterations with randomly generated `quoteId`, `corridorId`, `deliveryAmount`, and `midRate` values.

---

### Requirement 32: Property-Based Testing — EIP-3009 Nonce Anti-Replay

**User Story:** As a developer, I want a property-based test to verify that EIP-3009 nonces cannot be replayed under any sequence of inputs, so that the double-spend protection is exhaustively validated.

#### Acceptance Criteria

1. THE Property_Test SHALL generate random `(from, nonce, value, validBefore)` inputs, call `transferWithAuthorization` once successfully, then ONLY WHEN the first call succeeded call it again with the same `(from, nonce)` pair and different `to` / `value` parameters, asserting the second call always reverts with `AuthorizationAlreadyUsed`.
2. THE Property_Test SHALL verify that a nonce used in `cancelAuthorization` cannot subsequently be used in `transferWithAuthorization` (cancel-then-transfer replay).
3. THE Property_Test SHALL run at least 100 iterations with randomly generated nonces to confirm no nonce-aliasing issues.

---

### Requirement 33: Advanced Vulnerability — Integer Overflow in Margin Arithmetic

**User Story:** As a developer, I want tests to confirm that the settlement executor's margin arithmetic cannot overflow, so that Solidity 0.8.x checked arithmetic protection is verified at the boundary conditions relevant to this system.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that calls `executeSettlement` with `deliveryAmount = type(uint256).max / 2` (maximum feasible value near the overflow boundary) and BPS values summing to `10 000`, and verifies that the `totalDebit` computation either succeeds with the correct result or reverts with a Solidity panic (overflow), with no silent truncation.
2. THE Test_Suite SHALL include a test that calls `executeSettlement` with `deliveryAmount = 1` and all BPS values `= 0`, verifying that `totalDebit == 1` and no margin is deducted.
3. THE Test_Suite SHALL document the maximum safe `deliveryAmount` for a given set of BPS values given the `uint256` arithmetic used in `SettlementExecutorFacet`.

---

### Requirement 34: Advanced Vulnerability — Cross-Facet Reentrancy via Diamond Fallback

**User Story:** As a developer, I want to verify that the Diamond's `delegatecall` dispatch mechanism cannot be exploited to cause cross-facet reentrancy that bypasses `ReentrancyGuard`, so that the Diamond proxy itself does not introduce new attack surfaces.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that, during a settlement execution, attempts to call a second facet function (e.g. `reserveFloat`) via a reentrant call and verifies the reentrant call both reverts AND has no effect on the settlement in progress; both conditions must be asserted.
2. THE MarginWallet_Contract and `SettlementExecutorFacet` SHALL each use a SEPARATE `ReentrancyGuard` state slot so that cross-contract reentrancy between them is structurally prevented; the test suite SHALL verify this independence by confirming each contract's guard state is stored at a different storage location.

---

### Requirement 35: Advanced Vulnerability — Front-Running Resistance

**User Story:** As a developer, I want tests to confirm that quote nonce binding and settlement ID uniqueness make front-running economically useless, so that an attacker who copies a pending transaction cannot benefit from it.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a test that takes a valid signed quote + EIP-3009 authorization from a pending `executeSettlement` call, submits the same call from a different sender (attacker), and verifies it reverts with `"LibSettlement: not orchestrator"` because only the orchestrator can call `executeSettlement`; the test must be present AND successfully verify the expected behavior.
2. THE Test_Suite SHALL include a test that verifies the `settlementId` uniqueness check (`SettlementAlreadyExecuted`) prevents an attacker from re-submitting an already-mined settlement with modified parameters; the test must be present AND successfully verify the behavior.
3. THE Test_Suite SHALL include a test that verifies a quote submitted after its `validBefore` has elapsed reverts with `QuoteExpired`, demonstrating that stale intercepted quotes cannot be used; the test must actually work and pass.

---

### Requirement 36: Production Fix — Wire PausableFacet into Settlement Execution

**User Story:** As a system operator, I want the emergency pause to actually halt settlement execution and float reservations, so that I can stop all financial movement through a single admin action in a crisis without waiting for a Diamond upgrade.

#### Acceptance Criteria

1. WHEN `LibPausable.paused()` returns `true`, `SettlementExecutorFacet.executeSettlement` SHALL revert before any state change or transfer, preventing any new settlement from being executed while the system is paused.
2. WHEN `LibPausable.paused()` returns `true`, `SettlementExecutorFacet.executeSettlementAggregated` SHALL revert before any state change or transfer.
3. WHEN `LibPausable.paused()` returns `true`, `FloatManagerFacet.reserveFloat` SHALL revert, preventing new float commitments during a pause.
4. WHEN `LibPausable.paused()` returns `false`, all three functions listed in criteria 1–3 SHALL behave exactly as they do today without the pause check — no change to the non-paused code path.
5. THE `PausableFacet` SHALL be added to the `facetNames` array in `helpers.ts` so that it is included in the deployed Diamond used by all tests; after this change, `DiamondLoupeFacet.facets()` SHALL return 13 facets instead of 12.
6. THE Test_Suite SHALL include a test that pauses the system, calls `executeSettlement`, and asserts the call reverts with the system-paused error.
7. THE Test_Suite SHALL include a test that pauses, then unpauses, then calls `executeSettlement` with a valid settlement and asserts it succeeds (round-trip).

---

### Requirement 37: Production Fix — Implement Two-Step Admin Transfer

**User Story:** As a governance participant, I want admin key rotation to require explicit acceptance by the incoming admin address, so that a mistaken or compromised address can never silently inherit admin authority.

#### Acceptance Criteria

1. THE `TimeLockControllerFacet` (or a new `AdminTransferFacet`) SHALL expose a `transferAdmin(address pendingAdmin_)` function that writes the candidate address to `DiamondStorage.pendingAdmin` and emits `AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin)`.
2. THE `TimeLockControllerFacet` (or a new `AdminTransferFacet`) SHALL expose an `acceptAdmin()` function callable only by `DiamondStorage.pendingAdmin`; on success it SHALL write `msg.sender` into `DiamondStorage.admin`, clear `DiamondStorage.pendingAdmin` to `address(0)`, and emit `AdminTransferred(address indexed previousAdmin, address indexed newAdmin)`.
3. WHEN `transferAdmin` is called with `address(0)`, THE system SHALL revert with a descriptive error (e.g. `ZeroAdmin()`).
4. WHEN any address other than `DiamondStorage.admin` calls `transferAdmin`, THE system SHALL revert with `"LibSettlement: not admin"`.
5. WHEN any address other than `DiamondStorage.pendingAdmin` calls `acceptAdmin`, THE system SHALL revert with a descriptive error (e.g. `NotPendingAdmin()`).
6. WHEN `acceptAdmin` is called while `DiamondStorage.pendingAdmin == address(0)` (no transfer in progress), THE system SHALL revert.
7. THE existing `LibSettlement.enforceAdmin()` function SHALL continue to reference `DiamondStorage.admin` (the confirmed admin), not `pendingAdmin`.
8. THE Test_Suite SHALL verify the full two-step flow: `transferAdmin` → `acceptAdmin` → new admin can call all `enforceAdmin`-gated functions and old admin cannot.
9. THE Test_Suite SHALL verify that a wrong address cannot call `acceptAdmin` while a valid transfer is pending.

---

### Requirement 38: Production Fix — Enforce `maxQuoteTTL` in Quote Verification

**User Story:** As a security auditor, I want the on-chain oracle quote TTL cap to be enforced, so that an oracle cannot sign a quote with an excessively long validity window that could be exploited later.

#### Acceptance Criteria

1. WHEN `QuoteVerifierFacet.verifyAndDecodeQuote` is called with an `OracleQuote` where `validBefore - validAfter > DiamondStorage.maxQuoteTTL` (and `maxQuoteTTL > 0`), THE QuoteVerifierFacet SHALL revert with a descriptive error (e.g. `QuoteTTLExceeded(bytes32 quoteId, uint256 ttl, uint256 maxTTL)`).
2. WHEN `QuoteVerifierFacet.verifyAndDecodeAggregatedQuote` is called with the same condition, THE QuoteVerifierFacet SHALL revert with the same error.
3. WHEN `DiamondStorage.maxQuoteTTL == 0`, THE check SHALL be skipped entirely (zero is treated as "no cap"), preserving backwards compatibility with fixtures that set `maxQuoteTTL = 0`.
4. THE Test_Suite SHALL include a test that sets `maxQuoteTTL = 300` (5 minutes), submits a quote with `validBefore - validAfter = 301`, and asserts `QuoteTTLExceeded` is thrown.
5. THE Test_Suite SHALL include a test that submits a quote with `validBefore - validAfter = 300` (exactly at the cap) and asserts the verification succeeds.
6. THE Test_Suite SHALL include a test that sets `maxQuoteTTL = 0` and submits a quote with an arbitrarily large TTL, asserting verification succeeds (no-cap path).

---

### Requirement 39: Production Fix — Clarify and Remove Dead Storage Fields

**User Story:** As an auditor reviewing the Diamond storage layout, I want every field in `DiamondStorage` to be actively used or explicitly documented as reserved, so that the storage map is clean and free of confusion that could mask bugs or waste gas.

#### Acceptance Criteria

1. THE `usedNonces` mapping (`mapping(address => mapping(bytes32 => bool)) usedNonces`) in `LibSettlement.DiamondStorage` SHALL be either: (a) removed from the struct if it is permanently superseded by `EIP3009Extension._authorizationStates` on the token contract, or (b) actively written and read in at least one facet with a clear `@dev` comment explaining its purpose.
2. IF `usedNonces` is removed, THE storage slot ordering for all subsequent fields SHALL remain unchanged (the field SHALL be replaced with a `bytes32 _reserved_usedNonces` placeholder of identical size to preserve the layout of append-only fields below it).
3. THE `tgsTreasuryWallet` field SHALL be either: (a) used in a transfer leg in `SettlementExecutorFacet` with a corresponding business-logic justification, or (b) documented with a `// RESERVED — not used in current settlement flow` comment in `LibSettlement.DiamondStorage` until it is needed.
4. THE Test_Suite SHALL include a documentation test (comment + assertion) that enumerates all `DiamondStorage` fields and marks each as `ACTIVE` or `RESERVED`, serving as a living storage registry.

---

### Requirement 40: Production Fix — Pass Correct `corridorId` in `OutsideSettlementWindow` Error

**User Story:** As an on-chain monitoring engineer, I want the `OutsideSettlementWindow` error to carry the actual `corridorId` that rejected the settlement, so that my off-chain alert system can identify which corridor is misconfigured without a separate lookup.

#### Acceptance Criteria

1. THE `SettlementExecutorFacet._enforceWindow` function SHALL pass the `corridorId` parameter (or an identifier derived from it) to `OutsideSettlementWindow` instead of the hardcoded `0` that is currently emitted.
2. SINCE `_enforceWindow` currently only receives a `CorridorConfig storage` pointer (not the `corridorId` bytes32), THE function signature SHALL be updated to also accept `bytes32 corridorId` and pass it through to the revert.
3. ALL call sites of `_enforceWindow` in both `executeSettlement` and `executeSettlementAggregated` SHALL be updated to pass the `corridorId` variable that is already in scope at those call sites.
4. THE Test_Suite SHALL update existing `OutsideSettlementWindow` revert assertions to verify the emitted `corridorId` argument matches the configured corridor, not `bytes32(0)`.

---

### Requirement 41: Production Fix — Register ERC-165 Interface IDs in the Diamond

**User Story:** As a developer integrating with the GSDC Diamond, I want `supportsInterface(IDiamondCut)` and `supportsInterface(IDiamondLoupe)` to return `true`, so that standard tooling and wallet infrastructure can discover the Diamond's capabilities without custom code.

#### Acceptance Criteria

1. DURING `diamondCut` initialisation (in `DiamondInit.init` or a new initialiser step), THE Diamond SHALL register the `IDiamondCut` interface ID (`0x1f931c1c`) and the `IDiamondLoupe` interface ID (`0x48e2b093`) in `LibDiamond.DiamondStorage.supportedInterfaces`.
2. AFTER registration, calling `DiamondLoupeFacet.supportsInterface(0x1f931c1c)` SHALL return `true` and calling it with any random interface ID SHALL return `false`.
3. THE Test_Suite SHALL include a test asserting `supportsInterface` returns `true` for both `IDiamondCut` and `IDiamondLoupe` interface IDs on the deployed Diamond.

---

### Requirement 42: Production Fix — Add `DiamondInit` Re-initialisation Guard

**User Story:** As a security auditor, I want `DiamondInit.init` to be callable only once, so that an admin cannot accidentally or maliciously overwrite critical storage fields (admin, oracleSigner, gsdcToken) by re-running the initialiser.

#### Acceptance Criteria

1. THE `DiamondInit.init` function SHALL write a non-zero sentinel value to a dedicated `bool initialised` (or equivalent `uint8`) field in `LibSettlement.DiamondStorage` on first call.
2. WHEN `DiamondInit.init` is called a second time (sentinel already set), THE function SHALL revert with a descriptive error (e.g. `AlreadyInitialised()`).
3. THE sentinel field SHALL be appended to the end of `LibSettlement.DiamondStorage` in an append-only manner so no existing field offsets are disturbed.
4. THE Test_Suite SHALL include a test that calls `init` via `diamondCut` a second time and asserts `AlreadyInitialised()` is thrown.

---

### Requirement 43: Production Fix — Access-Control `disputeSettlement`

**User Story:** As an operator, I want `DisputeResolverFacet.disputeSettlement` to be callable only by registered partners (or the orchestrator), so that the on-chain audit trail cannot be flooded with spam events from anonymous addresses.

#### Acceptance Criteria

1. THE `DisputeResolverFacet.disputeSettlement` function SHALL check that `msg.sender` is either (a) the `lpSource` or `lpDest` recorded on the settlement, or (b) `DiamondStorage.orchestrator`, and revert with `UnauthorisedDisputant(address caller)` otherwise.
2. WHEN a registered partner who is neither `lpSource` nor `lpDest` on the settlement calls `disputeSettlement`, THE function SHALL revert with `UnauthorisedDisputant`.
3. WHEN an unregistered EOA calls `disputeSettlement`, THE function SHALL revert with `UnauthorisedDisputant`.
4. WHEN the orchestrator calls `disputeSettlement`, THE function SHALL succeed and emit `SettlementDisputed`.
5. THE Test_Suite SHALL include a test that asserts a random third-party EOA cannot dispute a settlement they are not party to.
6. THE Test_Suite SHALL include a test that asserts both `lpSource` and `lpDest` can successfully dispute their own settlement.

---

### Requirement 44: Production Fix — `ReentrancyGuard` Delegatecall Storage Collision Prevention

**User Story:** As a smart contract engineer, I want future Diamond facets that need reentrancy protection to use a dedicated storage-slot-based guard rather than inheriting OpenZeppelin's `ReentrancyGuard` directly, so that a storage slot collision between two facets sharing the same Diamond proxy cannot cause incorrect locking behaviour.

#### Acceptance Criteria

1. THE codebase SHALL include a `LibReentrancyGuard` library that stores its `_status` flag at a named, keccak256-derived storage slot (e.g. `keccak256("gsdc.reentrancy.guard.v1")`) isolated from both `LibDiamond` and `LibSettlement` slots.
2. THE `SettlementExecutorFacet` SHALL be refactored to use `LibReentrancyGuard` instead of directly inheriting `ReentrancyGuard` from OpenZeppelin, so that the guard state lives at the Diamond's dedicated slot rather than in the facet's default inherited slot position.
3. THE `LibReentrancyGuard` library SHALL expose `nonReentrantBefore()` and `nonReentrantAfter()` helpers (or an equivalent `modifier`) that replicate the existing `nonReentrant` semantics exactly.
4. THE Test_Suite SHALL verify that the `LibReentrancyGuard._status` slot does not collide with `LibDiamond.DIAMOND_STORAGE_POSITION`, `LibSettlement.SETTLEMENT_STORAGE_POSITION`, or `LibPausable.PAUSABLE_STORAGE_POSITION`.
5. AFTER the refactor, all existing reentrancy tests SHALL continue to pass without modification.

---

### Requirement 45: Production Fix — `ISettlementDiamond` Interface Completeness

**User Story:** As a backend developer consuming the Diamond ABI, I want `ISettlementDiamond` to expose every public settlement function including the aggregated path, `PausableFacet`, and new admin-transfer functions, so that the orchestrator's `DiamondClient` never needs to import per-facet ABIs for standard operations.

#### Acceptance Criteria

1. `ISettlementDiamond` SHALL declare `executeSettlementAggregated` with the correct multi-signer signature so the aggregated settlement path is reachable through the aggregated interface.
2. `ISettlementDiamond` SHALL declare `pause()`, `unpause()`, and `isPaused()` once `PausableFacet` is wired into the Diamond (Requirement 36).
3. `ISettlementDiamond` SHALL declare `transferAdmin(address)` and `acceptAdmin()` once the two-step admin transfer is implemented (Requirement 37).
4. `ISettlementDiamond` SHALL declare `configureCorridor(bytes32, bool, uint256, uint256, uint32, uint32)` which is currently present in `TimeLockControllerFacet` but absent from the interface.
5. THE Test_Suite SHALL include a compile-time or runtime check that every function callable on the Diamond proxy via `asFacet<ISettlementDiamond>()` is also declared in `ISettlementDiamond`, ensuring no drift between the interface and the deployed facets.
