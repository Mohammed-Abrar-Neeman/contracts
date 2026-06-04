// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "./libraries/LibSettlement.sol";

/// @title DiamondInit — one-shot Diamond storage initialiser
/// @notice Called via delegatecall from `LibDiamond.diamondCut` during the
///         initial cut. Sets admin, oracle signer, treasury wallet, defaults.
contract DiamondInit {
    struct InitArgs {
        address admin;
        address orchestrator; // [B-14 C3] separate from admin
        address oracleSigner;
        address gsdcToken;
        address tgsTreasuryWallet;
        address tgsTreasuryMarginWallet;
        uint32  maxQuoteTTL;
        uint32  timeLockDelay;
    }

    function init(InitArgs calldata a) external {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        ds.admin = a.admin;
        // [B-14 C3] If callers pass address(0) for orchestrator, default
        // to admin — preserves B-4..B-13 test fixtures that called init
        // with the legacy 7-field args struct (a.orchestrator gets zero-
        // initialised in that case). Production deploy scripts pass a
        // distinct address; the zero-fallback keeps unit tests + dev
        // fixtures green without re-plumbing every helper.
        ds.orchestrator = a.orchestrator == address(0) ? a.admin : a.orchestrator;
        ds.oracleSigner = a.oracleSigner;
        ds.gsdcToken = a.gsdcToken;
        ds.tgsTreasuryWallet = a.tgsTreasuryWallet;
        ds.tgsTreasuryMarginWallet = a.tgsTreasuryMarginWallet;
        ds.maxQuoteTTL = a.maxQuoteTTL;
        ds.timeLockDelay = a.timeLockDelay;
    }
}
