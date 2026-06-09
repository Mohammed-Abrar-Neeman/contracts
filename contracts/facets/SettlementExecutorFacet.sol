// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.SettlementExecutor — atomic 4-leg fan-out, nonReentrant.
// Bounded context: Settlement execution. Two entry points
// (single + aggregated) byte-identical except for signature verification.
// See docs/architecture/views/15-onchain-view.md §2 and ADR 0004.

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IEIP3009 } from "../interfaces/IEIP3009.sol";
import { LibSettlement } from "../libraries/LibSettlement.sol";
import { LibFloat } from "../libraries/LibFloat.sol";

/// @title SettlementExecutorFacet — atomic heart contract [SPEC §2.4]
/// @notice ALL transfers must succeed or ALL revert. No partial state.
/// @dev Highest-risk function in the system; CertiK audit must prove
///      atomicity under all branches.
contract SettlementExecutorFacet is ReentrancyGuard {
    /// @notice Thrown when `executeSettlement` (or its aggregated sibling) is
    ///         called twice with the same `settlementId`. Each settlement may
    ///         only be persisted once — the second call is rejected before any
    ///         state change to preserve audit-trail integrity.
    error SettlementAlreadyExecuted(bytes32 settlementId);
    /// @notice Thrown when admin recovery is attempted against a settlement
    ///         that was never executed (no record in Diamond storage).
    error SettlementNotFound(bytes32 settlementId);
    /// @notice Thrown when the corridor referenced by the settlement has been
    ///         disabled by `TimeLockControllerFacet.configureCorridor`. Settlements
    ///         on disabled corridors are blocked even if the quote was signed
    ///         while the corridor was still active.
    error CorridorNotActive(bytes32 corridorId);
    /// @notice Thrown when either `lpSource` or `lpDest` is not a registered
    ///         partner OR is registered but not authorised for this corridor.
    error PartnerNotAuthorised(address partner, bytes32 corridorId);
    /// @notice Thrown when `block.timestamp` (mod 86 400) falls outside the
    ///         corridor's configured UTC settlement window. Wrap-around windows
    ///         (e.g. 22:00 → 04:00) are supported.
    error OutsideSettlementWindow(bytes32 corridorId);
    /// @notice Thrown when `deliveryAmount` is below the corridor's
    ///         `minDeliveryAmount`. Keeps gas-amortised settlements economical.
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    /// @notice Thrown when `deliveryAmount` exceeds the corridor's
    ///         `maxDeliveryAmount`. A `maxDeliveryAmount` of 0 disables the cap.
    error AmountAboveMaximum(uint256 amount, uint256 maximum);
    /// @notice Thrown when the verified oracle quote's `quoteId` or
    ///         `corridorId` does not match the values supplied by the caller —
    ///         protects against quote-substitution attacks.
    error QuoteCorridorMismatch();
    /// @notice [B-14 C1] Thrown when the `deliveryAmount` parameter passed to
    ///         executeSettlement (or its aggregated sibling) does not match the
    ///         amount that was signed inside the verified oracle quote. Protects
    ///         against bait-and-switch attacks where a caller could submit a
    ///         tiny signed quote but request a much larger transfer.
    error DeliveryAmountMismatch(uint256 supplied, uint256 signed);
    /// @notice Thrown when the EIP-3009 authorization blob is not exactly
    ///         97 bytes (32-byte `validBefore` + 65-byte `r||s||v`). Must
    ///         revert before reaching `transferWithAuthorization` to avoid
    ///         consuming the source LP's nonce on a malformed payload.
    error InvalidAuthorizationSig();

    /// @notice Emitted on the SETTLED transition. Indexed by `settlementId`,
    ///         `corridorId`, and `lpSource` so back-office indexers can filter
    ///         by partner-corridor pairs without scanning the full topic.
    event SettlementExecuted(
        bytes32 indexed settlementId,
        bytes32 indexed corridorId,
        address indexed lpSource,
        address lpDest,
        uint256 deliveryAmount,
        uint256 totalDebit,
        uint256 lpSourceMargin,
        uint256 tgsTreasuryMargin,
        uint256 lpDestMargin,
        uint256 settledAt
    );
    /// @notice Emitted when admin moves a settlement to FAILED via
    ///         `recoverFailedSettlement`. The `reason` string lets the audit
    ///         trail capture an off-chain RCA reference.
    event SettlementFailed(bytes32 indexed settlementId, string reason);

    /// @notice Atomically debit `lpSource`, credit `lpDest` with the delivery
    ///         amount, and route the three margin slices to the LP source,
    ///         TGS treasury, and LP destination margin wallets.
    /// @dev    [SPEC §2.4] B-6 [CARRY-CRITICAL RESOLVED]: the test bypass
    ///         that previously skipped quote verification + EIP-3009
    ///         redemption when the signature blobs were empty has been
    ///         REMOVED — CertiK flagged it as a HIGH-severity on-chain
    ///         backdoor. The function now requires non-empty
    ///         encodedQuote + oracleSignature + authorizationSig in every
    ///         path that reaches the transfer fan-out.
    ///
    ///         To keep the failure-path tests (corridor / min-max /
    ///         window / partner auth) cheap to write, those checks now
    ///         run BEFORE quote verification. Tests that never reach the
    ///         transfer phase therefore don't need to mint signatures.
    ///         Only the happy-path tests + the double-execute "first
    ///         call" prelude need real signed quotes — `helpers.ts`
    ///         exposes `buildSignedQuote()` + `signEIP3009Authorization()`
    ///         for that purpose.
    ///
    ///         Access control: `LibSettlement.enforceOrchestrator()` —
    ///         only the configured Settlement Orchestrator backend may
    ///         call. ReentrancyGuard wraps the full 4-leg fan-out.
    /// @param settlementId      Globally-unique id; doubles as the EIP-3009
    ///                          authorization nonce to prevent replay.
    /// @param quoteId           Oracle quote id; must match the verified quote.
    /// @param corridorId        Corridor key; must match the verified quote and
    ///                          be active in Diamond storage.
    /// @param lpSource          Liquidity provider funding the transfer.
    /// @param lpDest            Liquidity provider receiving the delivery leg.
    /// @param deliveryAmount    GSDC units delivered to `lpDest`. Margin slices
    ///                          are derived as bps of this amount.
    /// @param encodedQuote      ABI-encoded `OracleQuote` tuple to verify.
    /// @param oracleSignature   65-byte ECDSA signature from the oracle signer.
    /// @param authorizationSig  97-byte EIP-3009 authorization (validBefore +
    ///                          r||s||v) signed by `lpSource`.
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
    ) external nonReentrant {
        LibSettlement.enforceOrchestrator();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();

        if (ds.settlements[settlementId].status != 0) revert SettlementAlreadyExecuted(settlementId);

        // [CARRY-CRITICAL] Pre-verification gates moved here so failure-
        // path tests don't need to mint quote signatures just to hit
        // these reverts. Auditor: this is a pure reorder — no semantic
        // change, since any of these reverts were already mandatory.
        LibSettlement.CorridorConfig storage c = ds.corridors[corridorId];
        if (!c.active) revert CorridorNotActive(corridorId);
        if (deliveryAmount < c.minDeliveryAmount) revert AmountBelowMinimum(deliveryAmount, c.minDeliveryAmount);
        if (c.maxDeliveryAmount != 0 && deliveryAmount > c.maxDeliveryAmount) {
            revert AmountAboveMaximum(deliveryAmount, c.maxDeliveryAmount);
        }
        _enforceWindow(c);

        if (!ds.partners[lpSource].active || !ds.partners[lpSource].authorisedCorridors[corridorId]) {
            revert PartnerNotAuthorised(lpSource, corridorId);
        }
        if (!ds.partners[lpDest].active || !ds.partners[lpDest].authorisedCorridors[corridorId]) {
            revert PartnerNotAuthorised(lpDest, corridorId);
        }

        // [CARRY-CRITICAL] Cross-facet oracle-quote verification — now
        // mandatory. No empty-bypass branch. staticcall keeps the read
        // in the Diamond's storage frame so LibSettlement state is
        // shared with the verifier.
        {
            bytes memory verifyData = abi.encodeWithSelector(
                bytes4(keccak256("verifyAndDecodeQuote(bytes,bytes)")),
                encodedQuote, oracleSignature
            );
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory ret) = address(this).staticcall(verifyData);
            if (!ok) {
                // Bubble the verifier facet's revert reason.
                // solhint-disable-next-line no-inline-assembly
                assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
            }
            (bytes32 verifiedQuoteId, bytes32 verifiedCorridorId, uint256 verifiedDeliveryAmount)
                = _decodeQuoteHeader(ret);
            if (verifiedQuoteId != quoteId) revert QuoteCorridorMismatch();
            if (verifiedCorridorId != corridorId) revert QuoteCorridorMismatch();
            // [B-14 C1] Bind the deliveryAmount parameter to the signed quote.
            if (verifiedDeliveryAmount != deliveryAmount) {
                revert DeliveryAmountMismatch(deliveryAmount, verifiedDeliveryAmount);
            }
        }

        uint256 lpSourceMargin = (deliveryAmount * c.lpSourceMarginBps) / 10_000;
        uint256 tgsTreasuryMargin = (deliveryAmount * c.tgsTreasuryMarginBps) / 10_000;
        uint256 lpDestMargin = (deliveryAmount * c.lpDestMarginBps) / 10_000;
        uint256 totalDebit = deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin;

        // Persist pre-execution snapshot for audit trail.
        LibSettlement.Settlement storage s = ds.settlements[settlementId];
        s.settlementId = settlementId;
        s.quoteId = quoteId;
        s.corridorId = corridorId;
        s.lpSource = lpSource;
        s.lpDest = lpDest;
        s.deliveryAmount = deliveryAmount;
        s.totalDebit = totalDebit;
        s.lpSourceMargin = lpSourceMargin;
        s.tgsTreasuryMargin = tgsTreasuryMargin;
        s.lpDestMargin = lpDestMargin;
        s.status = 1; // EXECUTING
        s.createdAt = block.timestamp;

        // [CARRY-CRITICAL] EIP-3009 redemption is mandatory — the
        // transferFrom fallback that pre-approved the Diamond has been
        // removed. authorizationSig must be a 65-byte canonical
        // signature bound to settlementId as the nonce.
        IERC20 token = IERC20(ds.gsdcToken);
        _redeemAuthorization(ds.gsdcToken, lpSource, address(this), totalDebit, settlementId, authorizationSig);
        require(token.transfer(lpDest, deliveryAmount), "transfer to dest failed");
        require(token.transfer(ds.partners[lpSource].marginWallet, lpSourceMargin), "src margin failed");
        require(token.transfer(ds.tgsTreasuryMarginWallet, tgsTreasuryMargin), "tgs margin failed");
        require(token.transfer(ds.partners[lpDest].marginWallet, lpDestMargin), "dest margin failed");

        // Release any reservation that may exist for this settlement.
        LibFloat.release(lpSource, settlementId);

        s.status = 2; // SETTLED
        s.settledAt = block.timestamp;

        emit SettlementExecuted(
            settlementId, corridorId, lpSource, lpDest,
            deliveryAmount, totalDebit, lpSourceMargin, tgsTreasuryMargin, lpDestMargin,
            block.timestamp
        );
    }

    /// @notice Multi-signer companion to `executeSettlement`. Used when the
    ///         orchestrator is configured for `ORACLE_MODE=MULTI_SIGNER`.
    /// @dev    [B-12 §4] Behaviour byte-identical to executeSettlement EXCEPT
    ///         the on-chain quote verification path: this variant calls
    ///         `QuoteVerifierFacet.verifyAndDecodeAggregatedQuote(bytes,
    ///         bytes[], bytes32)` instead of the single-signature
    ///         `verifyAndDecodeQuote(bytes, bytes)`. All other gates
    ///         (corridor active, min/max bounds, window, partner
    ///         authorisation, EIP-3009 redemption, atomic 4-leg fan-out)
    ///         are unchanged.
    ///
    ///         The orchestrator's StateMachine selects between the two
    ///         entrypoints via ORACLE_MODE. SINGLE_SIGNER preserves the
    ///         B-7 path with zero behavioural drift; MULTI_SIGNER closes
    ///         the orchestrator-side oracle-key custody [GAP].
    /// @param oracleSignatures Array of ≥`oracleThreshold` distinct DON-signer
    ///                         signatures over the aggregated quote digest.
    /// @param reportsRoot      Merkle root over per-signer DON report hashes.
    ///                         Stored in the typehash so future Phase 2 bundles
    ///                         don't need a typehash bump.
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
    ) external nonReentrant {
        LibSettlement.enforceOrchestrator();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();

        if (ds.settlements[settlementId].status != 0) revert SettlementAlreadyExecuted(settlementId);

        LibSettlement.CorridorConfig storage c = ds.corridors[corridorId];
        if (!c.active) revert CorridorNotActive(corridorId);
        if (deliveryAmount < c.minDeliveryAmount) revert AmountBelowMinimum(deliveryAmount, c.minDeliveryAmount);
        if (c.maxDeliveryAmount != 0 && deliveryAmount > c.maxDeliveryAmount) {
            revert AmountAboveMaximum(deliveryAmount, c.maxDeliveryAmount);
        }
        _enforceWindow(c);

        if (!ds.partners[lpSource].active || !ds.partners[lpSource].authorisedCorridors[corridorId]) {
            revert PartnerNotAuthorised(lpSource, corridorId);
        }
        if (!ds.partners[lpDest].active || !ds.partners[lpDest].authorisedCorridors[corridorId]) {
            revert PartnerNotAuthorised(lpDest, corridorId);
        }

        // [B-12 §4] Multi-signer verification — the QuoteVerifierFacet
        // checks threshold + whitelist + duplicates and reverts with
        // BelowThreshold / InvalidOracleSignature / DuplicateSigner.
        {
            bytes memory verifyData = abi.encodeWithSelector(
                bytes4(keccak256("verifyAndDecodeAggregatedQuote(bytes,bytes[],bytes32)")),
                encodedQuote, oracleSignatures, reportsRoot
            );
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory ret) = address(this).staticcall(verifyData);
            if (!ok) {
                // solhint-disable-next-line no-inline-assembly
                assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
            }
            (bytes32 verifiedQuoteId, bytes32 verifiedCorridorId, uint256 verifiedDeliveryAmount)
                = _decodeQuoteHeader(ret);
            if (verifiedQuoteId != quoteId) revert QuoteCorridorMismatch();
            if (verifiedCorridorId != corridorId) revert QuoteCorridorMismatch();
            // [B-14 C1] Bind the deliveryAmount parameter to the signed quote.
            if (verifiedDeliveryAmount != deliveryAmount) {
                revert DeliveryAmountMismatch(deliveryAmount, verifiedDeliveryAmount);
            }
        }

        uint256 lpSourceMargin = (deliveryAmount * c.lpSourceMarginBps) / 10_000;
        uint256 tgsTreasuryMargin = (deliveryAmount * c.tgsTreasuryMarginBps) / 10_000;
        uint256 lpDestMargin = (deliveryAmount * c.lpDestMarginBps) / 10_000;
        uint256 totalDebit = deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin;

        LibSettlement.Settlement storage s = ds.settlements[settlementId];
        s.settlementId = settlementId;
        s.quoteId = quoteId;
        s.corridorId = corridorId;
        s.lpSource = lpSource;
        s.lpDest = lpDest;
        s.deliveryAmount = deliveryAmount;
        s.totalDebit = totalDebit;
        s.lpSourceMargin = lpSourceMargin;
        s.tgsTreasuryMargin = tgsTreasuryMargin;
        s.lpDestMargin = lpDestMargin;
        s.status = 1; // EXECUTING
        s.createdAt = block.timestamp;

        IERC20 token = IERC20(ds.gsdcToken);
        _redeemAuthorization(ds.gsdcToken, lpSource, address(this), totalDebit, settlementId, authorizationSig);
        require(token.transfer(lpDest, deliveryAmount), "transfer to dest failed");
        require(token.transfer(ds.partners[lpSource].marginWallet, lpSourceMargin), "src margin failed");
        require(token.transfer(ds.tgsTreasuryMarginWallet, tgsTreasuryMargin), "tgs margin failed");
        require(token.transfer(ds.partners[lpDest].marginWallet, lpDestMargin), "dest margin failed");

        LibFloat.release(lpSource, settlementId);

        s.status = 2; // SETTLED
        s.settledAt = block.timestamp;

        emit SettlementExecuted(
            settlementId, corridorId, lpSource, lpDest,
            deliveryAmount, totalDebit, lpSourceMargin, tgsTreasuryMargin, lpDestMargin,
            block.timestamp
        );
    }

    /// @dev Pulls the first three fields out of an abi-encoded OracleQuote
    ///      tuple — quoteId, corridorId, deliveryAmount. The full tuple
    ///      decode would require constructing the entire struct just to
    ///      throw away the trailing fields; this saves IR stack depth.
    function _decodeQuoteHeader(bytes memory ret) internal pure
        returns (bytes32 quoteId, bytes32 corridorId, uint256 deliveryAmount)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            quoteId        := mload(add(ret, 0x40))
            corridorId     := mload(add(ret, 0x60))
            deliveryAmount := mload(add(ret, 0x80))
        }
    }

    /// @dev Calls IEIP3009.transferWithAuthorization on the GSDC token.
    ///      authorizationSig layout: 32 bytes validBefore || 65 bytes
    ///      r||s||v. The off-chain signer specifies validBefore in the
    ///      EIP-712 message; the contract reads it back here so the
    ///      digest the contract reconstructs matches what was signed.
    ///      Nonce is the settlementId — the source LP signs an
    ///      authorization bound to a specific settlement, preventing
    ///      cross-settlement replay.
    function _redeemAuthorization(
        address gsdcToken,
        address from,
        address to,
        uint256 value,
        bytes32 settlementId,
        bytes calldata sig
    ) internal {
        if (sig.length != 97) revert InvalidAuthorizationSig();
        uint256 validBefore;
        bytes32 r;
        bytes32 ssig;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            validBefore := calldataload(sig.offset)
            r := calldataload(add(sig.offset, 32))
            ssig := calldataload(add(sig.offset, 64))
            v := byte(0, calldataload(add(sig.offset, 96)))
        }
        IEIP3009(gsdcToken).transferWithAuthorization(
            from, to, value,
            0, validBefore,
            settlementId, v, r, ssig
        );
    }

    // [B-14 C6] recoverFailedSettlement REMOVED — CertiK flagged the admin
    // force-FAILED transition as a HIGH-severity bypass of the atomic
    // settlement state machine. The `SettlementFailed` event signature is
    // retained for ABI compatibility with off-chain indexers.

    /// @notice Read the persisted snapshot of a settlement.
    /// @param  settlementId Id assigned at execute time.
    /// @return Full `Settlement` struct (all-zero if not found).
    function getSettlement(bytes32 settlementId) external view returns (LibSettlement.Settlement memory) {
        return LibSettlement.diamondStorage().settlements[settlementId];
    }

    function _enforceWindow(LibSettlement.CorridorConfig storage c) internal view {
        uint256 sec = block.timestamp % 86400;
        bool inWindow;
        if (c.settlementWindowStart <= c.settlementWindowEnd) {
            inWindow = (sec >= c.settlementWindowStart && sec <= c.settlementWindowEnd);
        } else {
            inWindow = (sec >= c.settlementWindowStart || sec <= c.settlementWindowEnd);
        }
        if (!inWindow) revert OutsideSettlementWindow(0);
    }
}
