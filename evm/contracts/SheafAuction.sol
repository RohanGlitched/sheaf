// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Sheaf auction math
/// @notice The Dutch auction on share count that the v2 desk and the plan desk
/// share, written the way the Solana program writes it.
///
/// An order escrows a fixed amount of cash. The number of basket shares the
/// buyer must *receive* for it starts high and falls: `startShares` until
/// `startTs`, linear down to `endShares` at `endTs`, and no fill after that.
/// A filler takes it as soon as the count is one they can deliver at a profit,
/// so the buyer pays the going rate, never worse than `endShares` for the cash.
library SheafAuction {
    uint256 internal constant BPS = 10_000;
    /// A band wider than ±50% of fair is refused, as on Solana.
    uint16 internal constant MAX_BAND_BPS = 5_000;

    /// Shares the buyer must receive at `nowTs`. The decay is rounded down, so
    /// between the endpoints the buyer keeps the rounding.
    function sharesAt(uint256 startShares, uint256 endShares, uint64 startTs, uint64 endTs, uint256 nowTs)
        internal
        pure
        returns (uint256)
    {
        if (nowTs <= startTs) return startShares;
        if (nowTs >= endTs) return endShares;
        uint256 decay = Math.mulDiv(startShares - endShares, nowTs - startTs, endTs - startTs);
        return startShares - decay;
    }

    /// The auction for a fair share count: `fair × (1 + band)` down to
    /// `fair × (1 − band)`, both rounded down, with the end never below the
    /// buyer's own floor `minShares` (and the start never below the end).
    function bounds(uint256 fairShares, uint16 bandBps, uint256 minShares)
        internal
        pure
        returns (uint256 startShares, uint256 endShares)
    {
        startShares = Math.mulDiv(fairShares, BPS + bandBps, BPS);
        endShares = Math.mulDiv(fairShares, BPS - bandBps, BPS);
        if (endShares < minShares) endShares = minShares;
        if (startShares < endShares) startShares = endShares;
    }
}
