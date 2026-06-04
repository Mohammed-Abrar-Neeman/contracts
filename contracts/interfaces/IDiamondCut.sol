// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDiamondCut — EIP-2535 Diamond Standard
/// @author Nick Mudge (verbatim from reference implementation)
/// @dev [SPEC] Reference: https://github.com/mudgen/diamond
interface IDiamondCut {
    enum FacetCutAction { Add, Replace, Remove }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall.
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external;

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);
}
