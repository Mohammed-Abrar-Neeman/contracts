// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.OracleGovernanceFacet — DON signer whitelist + threshold mgmt.

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title OracleGovernanceFacet — manages the DON signer whitelist & threshold
contract OracleGovernanceFacet {
    uint256 internal constant MAX_SIGNERS = 10;

    error SignersBelowThreshold();
    error TooManySigners();
    error ThresholdBelowOne();
    error DuplicateSignerInList(address signer);
    error ZeroSigner();

    /// @notice [B-16 β-2] Declared so off-chain code resolves the event via this
    ///         facet's interface; emitted from TimeLockControllerFacet's
    ///         executeChange dispatcher. Same signature as on QV + TL — same
    ///         topic hash.
    event OracleSignersUpdated(
        address indexed actor,
        address[] oldSigners,
        address[] newSigners,
        uint256 oldThreshold,
        uint256 newThreshold,
        bytes32 indexed eventId
    );
    event ChangeQueued(bytes32 indexed changeId, uint256 executeAfter);

    /// @notice [B-16 β-2] Queue a DON whitelist + threshold rotation. All
    ///         validation runs at QUEUE TIME so a bad list cannot sit in the
    ///         pending map until execute. Apply via
    ///         `TimeLockControllerFacet.executeChange` after the delay.
    function queueOracleSignersChange(address[] memory signers, uint256 threshold)
        external returns (bytes32 changeId)
    {
        LibSettlement.enforceAdmin();
        if (threshold < 1) revert ThresholdBelowOne();
        if (signers.length > MAX_SIGNERS) revert TooManySigners();
        if (signers.length < threshold) revert SignersBelowThreshold();
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == address(0)) revert ZeroSigner();
            for (uint256 j = 0; j < i; j++) {
                if (signers[j] == signers[i]) revert DuplicateSignerInList(signers[i]);
            }
        }
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        bytes memory payload = abi.encode(signers, threshold);
        changeId = keccak256(abi.encode("oracleSigners", payload, block.timestamp, block.number));
        uint256 readyAt = block.timestamp + ds.timeLockDelay;
        ds.pendingChanges[changeId] = readyAt;
        ds.pendingChangePayloads[changeId] = payload;
        ds.pendingChangeKinds[changeId] = keccak256("oracleSigners");
        emit ChangeQueued(changeId, readyAt);
    }

    function getOracleSigners() external view returns (address[] memory) {
        return LibSettlement.diamondStorage().oracleSigners;
    }

    function getOracleThreshold() external view returns (uint256) {
        return LibSettlement.diamondStorage().oracleThreshold;
    }

    function isOracleSigner(address signer) external view returns (bool) {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        for (uint256 i = 0; i < ds.oracleSigners.length; i++) {
            if (ds.oracleSigners[i] == signer) return true;
        }
        return false;
    }
}
