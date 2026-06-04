// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title IGSDCMintBurn — minimal interface to the GSDC token's privileged ops.
interface IGSDCMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @title MintBurnAuthorityFacet [SPEC §2.1]
/// @notice Controlled GSDC mint/burn for float top-up and recovery operations.
///         Admin-only. The token contract itself enforces who can call mint/burn;
///         this facet records the operation in the audit trail and emits an event.
contract MintBurnAuthorityFacet {
    event FloatMinted(address indexed to, uint256 amount, address indexed actor);
    event FloatBurned(address indexed from, uint256 amount, address indexed actor);

    function mintFloat(address to, uint256 amount) external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        IGSDCMintBurn(ds.gsdcToken).mint(to, amount);
        emit FloatMinted(to, amount, msg.sender);
    }

    function burnFloat(address from, uint256 amount) external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        IGSDCMintBurn(ds.gsdcToken).burn(from, amount);
        emit FloatBurned(from, amount, msg.sender);
    }
}
