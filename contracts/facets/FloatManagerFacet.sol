// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibSettlement } from "../libraries/LibSettlement.sol";
import { LibFloat } from "../libraries/LibFloat.sol";
import { LibPausable } from "../libraries/LibPausable.sol";

/// @title FloatManagerFacet [SPEC §2.3]
contract FloatManagerFacet {
    error ReservationAlreadyExists(bytes32 settlementId);
    error SystemPaused();

    event FloatReserved(address indexed partner, bytes32 indexed settlementId, uint256 amount);
    event FloatReleased(address indexed partner, bytes32 indexed settlementId, uint256 amount);

    function getAvailableFloat(address partner)
        external view returns (uint256 available, uint256 reserved)
    {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 bal = IERC20(ds.gsdcToken).balanceOf(partner);
        reserved = ds.floatReservations[partner];
        available = bal >= reserved ? bal - reserved : 0;
    }

    function reserveFloat(address partner, bytes32 settlementId, uint256 amount) external {
        LibSettlement.enforceOrchestrator();
        if (LibPausable.paused()) revert SystemPaused();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        if (ds.settlementReservations[settlementId] != 0) revert ReservationAlreadyExists(settlementId);
        uint256 bal = IERC20(ds.gsdcToken).balanceOf(partner);
        LibFloat.reserve(partner, settlementId, amount, bal);
        emit FloatReserved(partner, settlementId, amount);
    }

    function releaseFloatReservation(address partner, bytes32 settlementId) external {
        LibSettlement.enforceOrchestrator();
        uint256 released = LibFloat.release(partner, settlementId);
        emit FloatReleased(partner, settlementId, released);
    }

    function getSettlementReservation(bytes32 settlementId) external view returns (uint256) {
        return LibSettlement.diamondStorage().settlementReservations[settlementId];
    }
}
