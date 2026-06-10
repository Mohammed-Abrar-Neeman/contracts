# Implementation Plan: GSDC Audit & Test Coverage

## Overview

Implements ten production-risk contract fixes (Reqs 36–45) plus full 100 % test coverage
(Reqs 1–35). Track A patches contracts; Track B writes the test suite. Both tracks share the
same Solidity 0.8.24 / Hardhat 2.22 / ethers v6 / TypeScript / fast-check 3.x stack.

## Tasks

- [x] 1. Install fast-check and update helpers.ts
  - [x] 1.1 Add `fast-check` to devDependencies and install
    - Run `npm install --save-dev fast-check` and verify `package.json` is updated
    - _Requirements: 28.1, 29.1, 30.1, 31.1, 32.1_
  - [x] 1.2 Patch `helpers.ts`: add `PausableFacet` to `facetNames` and fix TTL default
    - Add `"PausableFacet"` to the `facetNames` array so the facet is deployed in every `deployFullDiamond` call (Req 36.5)
    - Update `buildSignedQuote` so `validBefore` defaults to `blockTs + 299` when a `ttlSeconds` option is not supplied (keeps tests under the `maxQuoteTTL = 300` cap)
    - _Requirements: 36.5, 38.4, 38.5_


- [x] 2. Production Fix — LibReentrancyGuard (Req 44)
  - [x] 2.1 Create `contracts/libraries/LibReentrancyGuard.sol`
    - Write isolated keccak slot `keccak256("gsdc.reentrancy.guard.v1")`
    - Implement `nonReentrantBefore()` / `nonReentrantAfter()` with `NOT_ENTERED = 1` / `ENTERED = 2` constants
    - Revert using OZ-compatible selector `0x3ee5aeb5` (`ReentrancyGuardReentrantCall()`) for test compatibility
    - _Requirements: 44.1, 44.3_
  - [x] 2.2 Refactor `SettlementExecutorFacet` to use `LibReentrancyGuard`
    - Remove `ReentrancyGuard` inheritance and `nonReentrant` modifier
    - Add explicit `LibReentrancyGuard.nonReentrantBefore()` / `nonReentrantAfter()` calls to both `executeSettlement` and `executeSettlementAggregated`
    - _Requirements: 44.2, 44.5_

- [x] 3. Production Fix — Wire PausableFacet (Req 36)
  - [x] 3.1 Add `SystemPaused()` error and pause gate to `SettlementExecutorFacet`
    - Declare `error SystemPaused()` on `SettlementExecutorFacet`
    - Add `if (LibPausable.paused()) revert SystemPaused()` after `enforceOrchestrator()` in both settlement entry points
    - _Requirements: 36.1, 36.2, 36.4_
  - [x] 3.2 Add `SystemPaused()` error and pause gate to `FloatManagerFacet`
    - Declare `error SystemPaused()` on `FloatManagerFacet`
    - Add `if (LibPausable.paused()) revert SystemPaused()` after `enforceOrchestrator()` in `reserveFloat`
    - _Requirements: 36.3, 36.4_


- [ ] 4. Production Fix — Two-Step Admin Transfer (Req 37)
  - [x] 4.1 Add `transferAdmin` and `acceptAdmin` to `TimeLockControllerFacet`
    - Add errors: `ZeroAdmin()`, `NotPendingAdmin()`
    - Add events: `AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin)`, `AdminTransferred(address indexed previousAdmin, address indexed newAdmin)`
    - Implement `transferAdmin(address newAdmin) external` — enforces admin, rejects zero address, writes `ds.pendingAdmin`, emits event
    - Implement `acceptAdmin() external` — checks `msg.sender == ds.pendingAdmin`, rotates `ds.admin`, clears `ds.pendingAdmin`, emits event
    - _Requirements: 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7_

- [x] 5. Production Fix — maxQuoteTTL enforcement (Req 38)
  - [x] 5.1 Add `QuoteTTLExceeded` error and TTL check to `QuoteVerifierFacet`
    - Declare `error QuoteTTLExceeded(bytes32 quoteId, uint256 ttl, uint256 maxTTL)`
    - After expiry/validity checks in both `verifyAndDecodeQuote` and `verifyAndDecodeAggregatedQuote`, read `ds.maxQuoteTTL`; if `> 0` and `validBefore - validAfter > maxTTL`, revert
    - _Requirements: 38.1, 38.2, 38.3_

- [x] 6. Production Fix — Dead Storage Cleanup (Req 39)
  - [x] 6.1 Replace `usedNonces` with reserved sentinel in `LibSettlement.DiamondStorage`
    - Replace `mapping(address => mapping(bytes32 => bool)) usedNonces` with `bytes32 _reserved_slot_usedNonces` keeping slot [15] intact
    - Add `// RESERVED` comment to `tgsTreasuryWallet` field at slot [6]
    - _Requirements: 39.1, 39.2, 39.3_


- [x] 7. Production Fix — corridorId in window error (Req 40)
  - [x] 7.1 Update `_enforceWindow` signature and both call sites in `SettlementExecutorFacet`
    - Change `_enforceWindow(CorridorConfig storage c)` to `_enforceWindow(CorridorConfig storage c, bytes32 corridorId)`
    - Pass the `corridorId` argument to `OutsideSettlementWindow(corridorId)` instead of `(0)`
    - Update both call sites in `executeSettlement` and `executeSettlementAggregated`
    - _Requirements: 40.1, 40.2, 40.3_

- [x] 8. Production Fix — ERC-165 registration and DiamondInit guard (Reqs 41–42)
  - [x] 8.1 Register ERC-165 interface IDs in `DiamondInit.init`
    - Import `LibDiamond` and write `supportedInterfaces[0x1f931c1c] = true` (IDiamondCut) and `supportedInterfaces[0x48e2b093] = true` (IDiamondLoupe)
    - _Requirements: 41.1, 41.2_
  - [x] 8.2 Add `initialised` sentinel and re-init guard to `DiamondInit`
    - Append `bool initialised` to the end of `LibSettlement.DiamondStorage` (slot [22])
    - Declare `error AlreadyInitialised()` on `DiamondInit`
    - Add guard at top of `init()`: `if (ds.initialised) revert AlreadyInitialised()`; set `ds.initialised = true` at the end
    - _Requirements: 42.1, 42.2, 42.3_

- [x] 9. Production Fix — disputeSettlement access control and ISettlementDiamond completeness (Reqs 43, 45)
  - [x] 9.1 Restrict `DisputeResolverFacet.disputeSettlement` to LPs and orchestrator
    - Declare `error UnauthorisedDisputant(address caller)`
    - Add check: revert unless `msg.sender` is `stored.lpSource`, `stored.lpDest`, or `ds.orchestrator`
    - _Requirements: 43.1, 43.2, 43.3, 43.4_
  - [x] 9.2 Add missing functions to `ISettlementDiamond`
    - Add `executeSettlementAggregated(...)` with full multi-signer signature
    - Add `pause()`, `unpause()`, `isPaused()` for PausableFacet
    - Add `transferAdmin(address)`, `acceptAdmin()` for two-step admin
    - Add `configureCorridor(...)` for corridor lifecycle
    - _Requirements: 45.1, 45.2, 45.3, 45.4, 45.5_

- [x] 10. Compile all contract changes and verify no regressions
  - Run `npx hardhat compile` and confirm zero errors
  - Ensure all existing tests still pass: `npx hardhat test`
  - _Requirements: 36–45 (all production fixes)_


- [x] 11. Write `test/SecurityAudit.test.ts` — core audit tests (Reqs 1–14, 23–24)
  - [x] 11.1 System functionality & DiamondInit branch coverage
    - Req 1.1: `facetAddresses()` returns non-empty list; `facetFunctionSelectors()` populated for each facet
    - Req 1.2: Verify all `DiamondStorage` fields set to `InitArgs` values
    - Req 1.3: `orchestrator=0` → falls back to `admin` (Req 23.1)
    - Req 1.4: `orchestrator != 0` → stored as-is; orchestrator-gated calls succeed; admin calls fail (Req 23.2)
    - Req 1.5/24.1: Send ETH to Diamond, assert balance increases (ETH receive fallback)
    - Req 1.6: Storage slot values differ for LibSettlement, LibDiamond, LibPausable
    - Req 1.7: GSDCToken ERC-20 name/symbol + EIP-712 domain
    - Req 1.8: MarginWallet immutables
    - _Requirements: 1.1–1.8, 23.1, 23.2, 24.1_
  - [x] 11.2 Access control: admin and orchestrator reverts (Req 2)
    - For each `enforceAdmin`-gated function, call from non-admin and assert `"LibSettlement: not admin"`
    - For each `enforceOrchestrator`-gated function, call from non-orchestrator and assert `"LibSettlement: not orchestrator"`
    - `DiamondCutFacet` owner-only check; MarginWallet `deposit`/`withdraw` access
    - _Requirements: 2.1–2.7_
  - [x] 11.3 Reentrancy protection (Req 3)
    - Req 3.1: Settlement status set to 1 (EXECUTING) before transfers
    - Req 3.2: EIP-3009 nonce marked used before `_transfer`
    - Req 3.3: MarginWallet `deposit` + `withdraw` ReentrancyGuard
    - _Requirements: 3.1–3.3_
  - [x] 11.4 Write unit tests for security audit access-control edge cases
    - Test each `enforceAdmin`-gated function from a non-admin account
    - _Requirements: 2.6, 2.7_


- [x] 12. Write `test/SecurityAudit.test.ts` — EIP-712 and EIP-3009 tests (Reqs 4–5)
  - [x] 12.1 EIP-712 signature integrity tests
    - Req 4.1: Domain separator includes `chainId` + Diamond address
    - Req 4.2: Wrong signer → `InvalidOracleSignature()`
    - Req 4.3: Below threshold → `BelowThreshold(provided, required)`
    - Req 4.4: Duplicate signer → `DuplicateSigner(signer)`
    - Req 4.5/4.6: Expired and not-yet-valid quotes → respective reverts
    - Req 4.7: `isOverridden` field in `ORACLE_QUOTE_TYPEHASH`
    - Req 4.8: Aggregated typehash differs and includes `reportsRoot`
    - Req 4.9: `DeliveryAmountMismatch` on amount mismatch
    - Req 4.10: `QuoteCorridorMismatch` on quoteId/corridorId mismatch
    - Req 4.11/4.12: Valid quote passes; aggregated expiry/validity checks
    - _Requirements: 4.1–4.12_
  - [x] 12.2 EIP-3009 authorization integrity tests
    - Req 5.1: Replay with same nonce → `AuthorizationAlreadyUsed`
    - Req 5.2/5.3: Expired / not-yet-valid authorization reverts
    - Req 5.4: `authorizationSig` wrong length → `InvalidAuthorizationSig()`
    - Req 5.5: Cross-settlement replay reverts
    - Req 5.6: Expired auth in settlement flow reverts
    - Req 5.7: `cancelAuthorization` blocks subsequent `transferWithAuthorization`
    - Req 5.8: Round-trip sign/verify property (example-based)
    - _Requirements: 5.1–5.8_

- [x] 13. Write time-lock and settlement guard tests (Reqs 6–9)
  - [x] 13.1 Write `test/TimeLock.test.ts` — time-lock integrity and new admin transfer
    - Req 6.1: `ChangeNotReady` when called before delay (Req 19.1)
    - Req 6.2: `ChangeNotFound` for unknown changeId
    - Req 6.3: `UnknownKind` via `hardhat_setStorageAt` injection (Req 19.2, documented)
    - Req 6.4: Meta-time-lock `DelayChangeNotReady`
    - Req 6.5: `DelayChangeNotFound` when no delay queued
    - Req 6.6: `cancelChange` + `ChangeCancelled` + subsequent `ChangeNotFound`
    - Req 6.7: `queueMarginUpdate` → `executeChange` updates BPS + emits `ChangeExecuted`
    - Req 6.8: `MarginBpsSumExceedsMax` on sum > 10 000
    - Req 37 two-step admin: full flow, `ZeroAdmin`, non-admin reverts, wrong-address `acceptAdmin`, `acceptAdmin` when `pendingAdmin==0`
    - _Requirements: 6.1–6.8, 19.1–19.3, 37.1–37.9_
  - [x] 13.2 Write `test/SettlementWindow.test.ts` — settlement state machine and window tests
    - Req 7.1–7.12: All settlement state machine guards (CorridorNotActive, AmountBelowMinimum, etc.)
    - Req 18.1–18.4: Wrap-around window inside/outside for both entry points, using `evm_setNextBlockTimestamp`
    - Update existing `OutsideSettlementWindow(0)` assertions to use actual `corridorId` (Req 40.4)
    - Req 7.5/7.6/7.10 window reverts now assert `corridorId`, not zero
    - _Requirements: 7.1–7.13, 18.1–18.5, 40.4_


- [x] 14. Write float, compliance, dispute, and misc coverage tests (Reqs 8–14, 17, 20–22, 25–27)
  - [x] 14.1 Write float reservation tests in `test/BranchCoverage.test.ts` (extend existing file)
    - Req 8.1/17.2: `InsufficientFloat` when amount > available
    - Req 8.2/17.3: `ReservationAlreadyExists` on double-reserve
    - Req 8.3/17.4: `releaseFloatReservation` on unknown ID → no revert, `FloatReleased(amount=0)`
    - Req 8.4/17.1: Exact boundary success (`available == amount`)
    - Req 8.5/17.2: One-below boundary failure (`available == amount - 1`)
    - Req 8.6: Post-release `floatReservations[partner]` decreases by exactly R
    - Req 8.7/17.5: Double-release idempotence
    - Req 17.6: Non-orchestrator `reserveFloat` reverts
    - _Requirements: 8.1–8.7, 17.1–17.6_
  - [x] 14.2 Compliance, dispute, mint/burn, and margin tests
    - Req 9.1–9.4: ComplianceGate: suspended, unregistered, wrong corridor, `PartnerAlreadyRegistered` (Reqs 20.1–20.3)
    - Req 10.1–10.6: MintBurnAuthority: mint/burn admin paths, non-admin reverts, token owner check (Reqs 22.1–22.3)
    - Req 11.1–11.7: PausableFacet full lifecycle (pre-empted by task 15; add here if not present)
    - Req 12.1–12.7: OracleGovernance threshold/signer validation (Req 26.1–26.3)
    - Req 13.1–13.3: MarginSplitterFacet corridor guard + correct split (Reqs 25.1–25.2)
    - Req 14.1–14.2: DisputeResolverFacet: `SettlementNotFound`, valid dispute emits event (Req 21.1)
    - Req 27.1–27.2: AuthorizationExpired propagation via `evm_increaseTime`, scoped per test
    - _Requirements: 9.1–9.4, 10.1–10.6, 12.1–12.7, 13.1–13.3, 14.1–14.2, 20.1–20.3, 21.1, 22.1–22.3, 25.1–25.2, 26.1–26.3, 27.1–27.2_

- [x] 15. Write `test/PausableFacet.test.ts` (Reqs 11, 16, 36)
  - [x] 15.1 Implement full PausableFacet test file
    - `pause()` admin path → `isPaused() == true`, `Paused` event emitted
    - `unpause()` admin path → `isPaused() == false`, `Unpaused` event emitted
    - `pause()` twice → `AlreadyPaused()`
    - `unpause()` on unpaused system → `NotPaused()`
    - Non-admin `pause()` → `"LibSettlement: not admin"`
    - Non-admin `unpause()` → `"LibSettlement: not admin"`
    - `executeSettlement` blocked when paused → reverts with `SystemPaused()`
    - `reserveFloat` blocked when paused → reverts with `SystemPaused()`
    - Pause-unpause round-trip: `executeSettlement` succeeds after unpause
    - _Requirements: 11.1–11.7, 16.1–16.7, 36.1–36.7_


- [x] 16. Write `test/ProductionFixes.test.ts` (Reqs 36–45 one-to-one)
  - [x] 16.1 Req 36: `executeSettlementAggregated` and `reserveFloat` pause gate tests
    - `executeSettlementAggregated` reverts with `SystemPaused()` when paused
    - `reserveFloat` reverts with `SystemPaused()` when paused
    - _Requirements: 36.2, 36.3_
  - [x] 16.2 Req 38: maxQuoteTTL enforcement tests
    - `maxQuoteTTL=300`, TTL=301 → `QuoteTTLExceeded`
    - `maxQuoteTTL=300`, TTL=300 → succeeds
    - `maxQuoteTTL=0`, large TTL → succeeds (no-cap path)
    - Same for aggregated path
    - _Requirements: 38.1–38.6_
  - [x] 16.3 Req 39–42: Dead storage, corridorId error, ERC-165, re-init guard
    - Req 39: `_reserved_slot_usedNonces` reads as zero; dead storage registry comment
    - Req 40: `OutsideSettlementWindow` carries actual `corridorId` not zero
    - Req 41: `supportsInterface(0x1f931c1c)` and `supportsInterface(0x48e2b093)` return `true`; unknown ID returns `false`
    - Req 42: Second call to `DiamondInit.init` via `diamondCut` reverts `AlreadyInitialised()`
    - _Requirements: 39.1–39.4, 40.1–40.4, 41.1–41.3, 42.1–42.4_
  - [x] 16.4 Req 43–45: disputeSettlement AC, LibReentrancyGuard slot, interface completeness
    - Req 43: Third-party EOA → `UnauthorisedDisputant`; `lpSource`, `lpDest`, orchestrator each succeed
    - Req 44: LibRG slot ≠ LibSettlement, LibDiamond, LibPausable slots; reentrancy via assembly attack fails
    - Req 45: `ethers.getContractAt("ISettlementDiamond", addr)` TypeScript type-check for all new functions
    - _Requirements: 43.1–43.6, 44.1–44.5, 45.1–45.5_

- [x] 17. Write `test/AdvancedVulnerability.test.ts` (Reqs 33–35)
  - [x] 17.1 Integer overflow and zero-BPS boundary tests
    - `deliveryAmount = type(uint256).max / 2`, all BPS = 0 → `totalDebit == deliveryAmount`
    - `deliveryAmount = 1`, all BPS = 0 → `totalDebit == 1`, no margin deducted
    - Document max safe `deliveryAmount` for sum-of-BPS = 10 000 in test comments
    - _Requirements: 33.1–33.3_
  - [x] 17.2 Reentrancy attack via malicious token and cross-contract independence
    - Deploy `ReentrancyAttacker` contract that re-enters `executeSettlement` from a token callback; assert inner call reverts `SettlementAlreadyExecuted` (Req 3.4, 34.1)
    - Deploy `ReentrancyAttacker` for MarginWallet `withdraw`; assert inner call reverts `ReentrancyGuardReentrantCall()` (Req 3.5, 34.2)
    - Assert LibRG slot ≠ MarginWallet's guard slot
    - _Requirements: 3.4, 3.5, 34.1, 34.2_
  - [x] 17.3 Front-running resistance tests
    - Non-orchestrator submitting valid signed quote → `"LibSettlement: not orchestrator"` (Req 35.1)
    - Re-submit already-mined settlement → `SettlementAlreadyExecuted` (Req 35.2)
    - Submit quote after `validBefore` elapsed → `QuoteExpired` (Req 35.3)
    - Cross-settlement EIP-3009 replay → `AuthorizationAlreadyUsed` (Req 5.5)
    - `authorizationSig` wrong length → `InvalidAuthorizationSig()` (Req 5.4)
    - _Requirements: 5.4, 5.5, 35.1–35.3_


- [x] 18. Write `test/PropertyBased.test.ts` — all nine PBT properties (Reqs 28–32)
  - [x] 18.1 Property 1: Margin BPS sum invariant (200 runs)
    - Use `fc.tuple(fc.integer({min:0,max:65535}), ...)` for three BPS values
    - Assert `executeChange` reverts `MarginBpsSumExceedsMax` when sum > 10 000, succeeds and stores values when ≤ 10 000
    - Seed cases: `(0,0,0)`, `(3333,3334,3333)`, `(10000,1,0)`
    - Feature: gsdc-audit-test-coverage, Property 1: Margin BPS Sum Invariant
    - **Validates: Requirements 28.1, 28.2, 28.3, 28.4**
    - _Requirements: 28.1–28.4_
  - [x] 18.2 Write property test for Property 1 (margin BPS sum)
    - Implemented in 18.1 above; this sub-task marks the PBT status
    - **Property 1: Margin BPS Sum Invariant**
    - **Validates: Requirements 28.1, 28.2, 28.3, 28.4**
  - [x] 18.3 Property 2: Float reserve boundary rejection (200 runs)
    - `fc.bigUint({max:10n**27n}).chain(balance => fc.bigUint({min: balance+1n, ...}).map(amount => ({balance,amount})))`
    - Assert `reserve` reverts `InsufficientFloat` and leaves `floatReservations` unchanged
    - Feature: gsdc-audit-test-coverage, Property 2: Float Reserve Boundary Rejection
    - **Validates: Requirements 29.2, 8.5**
    - _Requirements: 29.2, 8.5_
  - [x] 18.4 Write property test for Property 2 (float boundary rejection)
    - **Property 2: Float Reserve Boundary Rejection**
    - **Validates: Requirements 29.2, 8.5**
  - [x] 18.5 Property 3: Float round-trip and release idempotence (200 runs)
    - Pair where `balance >= amount > 0`; verify `floatReservations` returns to pre-reserve after `release`; verify double-release is no-op
    - Use `evm_snapshot` / `evm_revert` per iteration
    - Feature: gsdc-audit-test-coverage, Property 3: Float Reservation Round-Trip
    - **Validates: Requirements 29.1, 29.3, 29.4, 8.4, 8.6, 8.7**
    - _Requirements: 29.1, 29.3, 29.4, 8.4, 8.6, 8.7_
  - [x] 18.6 Write property test for Property 3 (float round-trip)
    - **Property 3: Float Reservation Round-Trip**
    - **Validates: Requirements 29.1, 29.3, 29.4, 8.4, 8.6, 8.7**


  - [x] 18.7 Property 4: Settlement state machine forward-only (100 runs)
    - `fc.bigInt({min:1000n, max:1_000_000n})` for `deliveryAmount`; unique `settlementId` per iteration via `keccak256(String(i))`
    - Assert after success: `status==2`, `settledAt>=createdAt`, `totalDebit==deliveryAmount+margins`
    - Assert re-execute with same `settlementId` → `SettlementAlreadyExecuted`
    - Feature: gsdc-audit-test-coverage, Property 4: Settlement State Machine Forward-Only Transition
    - **Validates: Requirements 30.1, 30.2, 30.3, 30.4, 7.1, 7.12**
    - _Requirements: 30.1–30.5, 7.1, 7.12_
  - [x] 18.8 Write property test for Property 4 (settlement state machine)
    - **Property 4: Settlement State Machine Forward-Only Transition**
    - **Validates: Requirements 30.1, 30.2, 30.3, 30.4, 7.1, 7.12**
  - [x] 18.9 Property 5: EIP-712 signing round-trip (100 runs)
    - `fc.record({quoteId: fc.hexaString(...), deliveryAmount: fc.bigInt(...), midRate: fc.string(...)})`
    - Assert `buildSignedQuote` + `verifyAndDecodeQuote` succeeds with oracle key; fails with different Diamond address
    - Also verify `quoteDomainSeparator()` stable across multiple calls
    - Feature: gsdc-audit-test-coverage, Property 5: EIP-712 Signing Round-Trip
    - **Validates: Requirements 31.2, 31.3, 4.1, 4.11**
    - _Requirements: 31.1–31.4, 4.1, 4.11_
  - [x] 18.10 Write property test for Property 5 (EIP-712 round-trip)
    - **Property 5: EIP-712 Signing Round-Trip**
    - **Validates: Requirements 31.2, 31.3, 4.1, 4.11**
  - [x] 18.11 Property 6: EIP-3009 nonce anti-replay (100 runs)
    - `fc.record({nonce: fc.hexaString(...), value: fc.bigInt({min:1n,max:1000n})})`
    - First `transferWithAuthorization` succeeds; second with same `(from, nonce)` → `AuthorizationAlreadyUsed`
    - Cancel path: `cancelAuthorization` then `transferWithAuthorization` → `AuthorizationAlreadyUsed`
    - Feature: gsdc-audit-test-coverage, Property 6: EIP-3009 Nonce Anti-Replay
    - **Validates: Requirements 32.1, 32.2, 5.1, 5.7**
    - _Requirements: 32.1–32.3, 5.1, 5.7_
  - [x] 18.12 Write property test for Property 6 (EIP-3009 anti-replay)
    - **Property 6: EIP-3009 Nonce Anti-Replay**
    - **Validates: Requirements 32.1, 32.2, 5.1, 5.7**


  - [x] 18.13 Property 7: Pause-unpause round-trip restores settlement (100 runs)
    - `fc.bigInt({min:1000n, max:500_000n})` for `deliveryAmount`
    - Pause → assert `executeSettlement` reverts `SystemPaused` → unpause → assert `executeSettlement` succeeds
    - Feature: gsdc-audit-test-coverage, Property 7: Pause-Unpause Round-Trip
    - **Validates: Requirements 36.4, 36.7**
    - _Requirements: 36.4, 36.7_
  - [x] 18.14 Write property test for Property 7 (pause round-trip)
    - **Property 7: Pause-Unpause Round-Trip Restores Settlement Capability**
    - **Validates: Requirements 36.4, 36.7**
  - [x] 18.15 Property 8: Quote TTL enforcement (200 runs)
    - `fc.integer({min:1,max:10000}).chain(maxTTL => fc.integer({min:maxTTL+1,max:86400}).map(ttl => ({ttl,maxTTL})))`
    - When `ttl > maxTTL > 0` → `QuoteTTLExceeded`; when `maxTTL == 0` → passes
    - Feature: gsdc-audit-test-coverage, Property 8: Quote TTL Enforcement
    - **Validates: Requirements 38.1, 38.2, 38.3**
    - _Requirements: 38.1–38.3_
  - [x] 18.16 Write property test for Property 8 (quote TTL)
    - **Property 8: Quote TTL Enforcement**
    - **Validates: Requirements 38.1, 38.2, 38.3**
  - [x] 18.17 Property 9: OutsideSettlementWindow carries actual corridorId (100 runs)
    - `fc.record({corridorId: fc.hexaString(...), windowStart: fc.integer({min:0,max:86399})})`
    - Configure corridor, set timestamp outside window, assert error carries exact `corridorId` not zero
    - Feature: gsdc-audit-test-coverage, Property 9: OutsideSettlementWindow CorridorId
    - **Validates: Requirements 40.1, 40.2, 40.3, 7.5, 7.6, 7.10**
    - _Requirements: 40.1–40.4, 7.5, 7.6, 7.10_
  - [x] 18.18 Write property test for Property 9 (corridorId in window error)
    - **Property 9: OutsideSettlementWindow Carries Actual CorridorId**
    - **Validates: Requirements 40.1, 40.2, 40.3, 7.5, 7.6, 7.10**

- [x] 19. Checkpoint — Ensure all unit and property-based tests pass
  - Run `npx hardhat test` and confirm all tests green
  - Ask the user if questions arise before proceeding to coverage measurement


- [x] 20. Update `.solcover.js` and coverage configuration (Req 15)
  - [x] 20.1 Set 100 % coverage gates in `.solcover.js` and `hardhat.config.ts`
    - Configure `mocha: { timeout: 600_000 }`, `configureYulOptimizer: true`, `istanbulReporter: ["html","lcov","text"]`
    - Add coverage threshold block to `hardhat.config.ts` with `lines/branches/functions/statements: 100`
    - _Requirements: 15.1, 15.2, 15.3_

- [x] 21. Final checkpoint — 100 % coverage gate and clean baseline
  - Run `npx hardhat coverage` (or `npx hardhat test --coverage` equivalent); confirm all four metrics reach 100 %
  - If any line/branch/function/statement is uncovered, add targeted tests until the gate is met
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP; they document PBT annotations but the actual tests are implemented in the parent task
- Each task references specific requirements for traceability
- Checkpoints at tasks 10, 19, and 21 ensure incremental validation
- Property tests require `fast-check` (task 1.1); install it before running tasks 18.x
- The `evm_snapshot` / `evm_revert` caching pattern in `helpers.ts` keeps the full test suite under 15 minutes — all new tests MUST use `deployFullDiamond()` not `_deployFullDiamondImpl()`
- For `UnknownKind` branch coverage (Req 19.2), use `hardhat_setStorageAt` to inject a changeId with a non-standard kind; document the storage offset derivation in the test file
- All `OutsideSettlementWindow` revert assertions (tasks 13.2, 16.3, 18.17) must be updated to pass the actual `corridorId` after task 7.1 lands
- `buildSignedQuote` TTL default must be updated (task 1.2) before task 18.x tests run against a `maxQuoteTTL=300` fixture

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["3.1", "3.2", "4.1", "5.1", "6.1", "7.1", "8.1", "8.2", "9.1", "9.2"] },
    { "id": 4, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 5, "tasks": ["11.4", "12.1", "12.2", "13.1", "13.2", "14.1", "14.2"] },
    { "id": 6, "tasks": ["15.1", "16.1", "16.2", "16.3", "16.4", "17.1", "17.2", "17.3"] },
    { "id": 7, "tasks": ["18.1", "18.2", "18.3", "18.4", "18.5", "18.6", "18.7", "18.8", "18.9", "18.10", "18.11", "18.12", "18.13", "18.14", "18.15", "18.16", "18.17", "18.18"] },
    { "id": 8, "tasks": ["20.1"] }
  ]
}
```
