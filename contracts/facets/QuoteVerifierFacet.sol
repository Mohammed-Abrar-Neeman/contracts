// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.QuoteVerifier — EIP-712 quote verification (single + aggregated).

import { LibSettlement } from "../libraries/LibSettlement.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title QuoteVerifierFacet [SPEC §2.5]
/// @notice Verifies EIP-712 signed oracle quotes; rejects expired or wrong-signer.
contract QuoteVerifierFacet {
    bytes32 private constant _DOMAIN_NAME_HASH = keccak256(bytes("GSDCOracle"));
    bytes32 private constant _DOMAIN_VERSION_HASH = keccak256(bytes("1"));
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // [B-14 C8] `isOverridden` appended to canonical typehash; binds the
    // orchestrator override flag into the EIP-712 signature.
    bytes32 public constant ORACLE_QUOTE_TYPEHASH = keccak256(
        "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount,"
        "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps,"
        "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate,"
        "bool isOverridden)"
    );

    bytes32 public constant ORACLE_QUOTE_AGGREGATED_TYPEHASH = keccak256(
        "OracleQuoteAggregated(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount,"
        "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps,"
        "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate,"
        "bytes32 reportsRoot,bool isOverridden)"
    );

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
        bool    isOverridden;
    }

    error InvalidOracleSignature();
    error QuoteExpired(bytes32 quoteId, uint256 expiredAt);
    error QuoteNotYetValid(bytes32 quoteId, uint256 validAfter);
    error BelowThreshold(uint256 provided, uint256 required);
    error DuplicateSigner(address signer);

    /// @notice Legacy event retained for ABI compatibility (no emitter remains
    ///         in this facet — singular rotation now emits the unified
    ///         `OracleSignersUpdated` from TimeLockControllerFacet).
    event OracleSignerUpdated(address indexed oldSigner, address indexed newSigner);

    // [B-16 β] Declared so off-chain code can resolve the event on this
    // facet's interface; emitted from TimeLockControllerFacet.
    event ChangeQueued(bytes32 indexed changeId, uint256 executeAfter);
    event OracleSignersUpdated(
        address indexed actor,
        address[] oldSigners,
        address[] newSigners,
        uint256 oldThreshold,
        uint256 newThreshold,
        bytes32 indexed eventId
    );

    function verifyAndDecodeAggregatedQuote(
        bytes calldata encodedQuote,
        bytes[] calldata signatures,
        bytes32 reportsRoot
    ) external view returns (OracleQuote memory quote) {
        quote = abi.decode(encodedQuote, (OracleQuote));
        if (block.timestamp <= quote.validAfter) revert QuoteNotYetValid(quote.quoteId, quote.validAfter);
        if (block.timestamp >= quote.validBefore) revert QuoteExpired(quote.quoteId, quote.validBefore);

        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 thr = ds.oracleThreshold;
        if (signatures.length < thr) revert BelowThreshold(signatures.length, thr);

        bytes32 structHash = keccak256(abi.encode(
            ORACLE_QUOTE_AGGREGATED_TYPEHASH,
            quote.quoteId, quote.corridorId, quote.deliveryAmount, quote.totalDebit,
            quote.lpSourceMarginBps, quote.tgsTreasuryMarginBps, quote.lpDestMarginBps,
            quote.validAfter, quote.validBefore, keccak256(bytes(quote.midRate)),
            reportsRoot,
            quote.isOverridden
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));

        address[] memory recovered = new address[](signatures.length);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer == address(0)) revert InvalidOracleSignature();
            bool ok = false;
            for (uint256 j = 0; j < ds.oracleSigners.length; j++) {
                if (ds.oracleSigners[j] == signer) { ok = true; break; }
            }
            if (!ok) revert InvalidOracleSignature();
            for (uint256 k = 0; k < i; k++) {
                if (recovered[k] == signer) revert DuplicateSigner(signer);
            }
            recovered[i] = signer;
        }
    }

    function verifyAndDecodeQuote(bytes calldata encodedQuote, bytes calldata signature)
        external view returns (OracleQuote memory quote)
    {
        quote = abi.decode(encodedQuote, (OracleQuote));
        if (block.timestamp <= quote.validAfter) revert QuoteNotYetValid(quote.quoteId, quote.validAfter);
        if (block.timestamp >= quote.validBefore) revert QuoteExpired(quote.quoteId, quote.validBefore);

        bytes32 structHash = keccak256(abi.encode(
            ORACLE_QUOTE_TYPEHASH,
            quote.quoteId, quote.corridorId, quote.deliveryAmount, quote.totalDebit,
            quote.lpSourceMarginBps, quote.tgsTreasuryMarginBps, quote.lpDestMarginBps,
            quote.validAfter, quote.validBefore, keccak256(bytes(quote.midRate)),
            quote.isOverridden
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address recovered = ECDSA.recover(digest, signature);
        if (recovered == address(0) || recovered != LibSettlement.diamondStorage().oracleSigner) {
            revert InvalidOracleSignature();
        }
    }

    /// @notice [B-16 β-2] Queue a rotation of the singleton `oracleSigner`.
    ///         Apply via `TimeLockControllerFacet.executeChange` after the
    ///         configured delay. Immediate-effect setter removed (audit NEW-010).
    function queueOracleSignerChange(address newSigner) external returns (bytes32 changeId) {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        bytes memory payload = abi.encode(newSigner);
        changeId = keccak256(abi.encode("oracleSigner", payload, block.timestamp, block.number));
        uint256 readyAt = block.timestamp + ds.timeLockDelay;
        ds.pendingChanges[changeId] = readyAt;
        ds.pendingChangePayloads[changeId] = payload;
        ds.pendingChangeKinds[changeId] = keccak256("oracleSigner");
        emit ChangeQueued(changeId, readyAt);
    }

    function quoteDomainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            _DOMAIN_TYPEHASH,
            _DOMAIN_NAME_HASH,
            _DOMAIN_VERSION_HASH,
            block.chainid,
            address(this)
        ));
    }
}
