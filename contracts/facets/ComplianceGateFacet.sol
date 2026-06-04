// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title ComplianceGateFacet [SPEC §2.6]
contract ComplianceGateFacet {
    error PartnerAlreadyRegistered(address partner);
    error PartnerNotAuthorised(address partner, bytes32 corridorId);
    error PartnerSuspended_(address partner);

    event PartnerRegistered(address indexed partner, bytes32 kycHash);
    event PartnerSuspended(address indexed partner);
    event PartnerReactivated(address indexed partner);
    event PartnerCorridorAdded(address indexed partner, bytes32 indexed corridorId);

    function checkCompliance(address partner, bytes32 corridorId) external view returns (bool) {
        LibSettlement.PartnerConfig storage p = LibSettlement.diamondStorage().partners[partner];
        if (!p.active) revert PartnerSuspended_(partner);
        if (p.kycHash == bytes32(0)) revert PartnerNotAuthorised(partner, corridorId);
        if (!p.authorisedCorridors[corridorId]) revert PartnerNotAuthorised(partner, corridorId);
        return true;
    }

    function registerPartner(
        address partner,
        address floatWallet,
        address marginWallet,
        bytes32 kycHash,
        bytes32[] calldata corridorIds
    ) external {
        LibSettlement.enforceAdmin();
        LibSettlement.PartnerConfig storage p = LibSettlement.diamondStorage().partners[partner];
        if (p.kycHash != bytes32(0)) revert PartnerAlreadyRegistered(partner);
        p.floatWallet = floatWallet;
        p.marginWallet = marginWallet;
        p.kycHash = kycHash;
        p.active = true;
        for (uint256 i = 0; i < corridorIds.length; i++) {
            if (!p.authorisedCorridors[corridorIds[i]]) {
                p.authorisedCorridors[corridorIds[i]] = true;
                p.corridorCount++;
            }
        }
        emit PartnerRegistered(partner, kycHash);
    }

    function suspendPartner(address partner) external {
        LibSettlement.enforceAdmin();
        LibSettlement.diamondStorage().partners[partner].active = false;
        emit PartnerSuspended(partner);
    }

    function reactivatePartner(address partner) external {
        LibSettlement.enforceAdmin();
        LibSettlement.diamondStorage().partners[partner].active = true;
        emit PartnerReactivated(partner);
    }

    function addPartnerCorridor(address partner, bytes32 corridorId) external {
        LibSettlement.enforceAdmin();
        LibSettlement.PartnerConfig storage p = LibSettlement.diamondStorage().partners[partner];
        if (!p.authorisedCorridors[corridorId]) {
            p.authorisedCorridors[corridorId] = true;
            p.corridorCount++;
            emit PartnerCorridorAdded(partner, corridorId);
        }
    }
}
