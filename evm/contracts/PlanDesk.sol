// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CreationDeskV2} from "./CreationDeskV2.sol";
import {SheafAuction} from "./SheafAuction.sol";

/// @title Sheaf plan desk
/// @notice Recurring buys whose amount, schedule and worst price are written on
/// chain by the plan's owner, so whoever triggers an instalment can neither
/// overspend nor overpay on the owner's behalf.
///
/// The owner opens a plan once: the basket, the cash per run, the minimum time
/// between runs, the auction's band and length, and two bounds on the fair
/// share count for one run's cash. `minShares` is the owner's price cap: no
/// run's auction ever ends below it, so a run never buys fewer shares than
/// that for `cashPerRun`. `maxShares` stops a trigger from posting a fair so
/// high that no filler would take it.
///
/// Each instalment pulls exactly `cashPerRun` from the owner, centres an
/// auction on the fair count the caller supplies (which must sit inside the
/// owner's bounds), and posts it on the v2 desk with the owner as buyer, so the
/// shares and any refund go to the owner. Any filler can take it.
///
/// On Tempo the owner's access key (the keeper) is scoped to two calls only:
/// `cash.approve` with this contract as spender, and `instalment`. A key that
/// signs for the owner is `msg.sender == owner` here, so the terms must never
/// be callable by it: `openPlan` and `closePlan` stay outside its scope and
/// the access key can only run the plan the owner wrote. On a chain without
/// access keys, the owner can name a `keeper` that may call `instalment` too,
/// against a standing allowance; the same terms bound it.
contract PlanDesk is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// Packed into five slots.
    struct Plan {
        address owner;
        uint64 interval;
        uint32 runs;
        bool active;
        address basket;
        uint64 lastRunAt;
        address keeper;
        uint64 auctionSecs;
        uint16 bandBps;
        uint128 cashPerRun;
        uint128 minShares;
        uint128 maxShares;
    }

    CreationDeskV2 public immutable desk;
    IERC20 public immutable cash;

    Plan[] private _plans;
    mapping(address => uint256[]) private _plansOf;

    event PlanOpened(
        uint256 indexed id,
        address indexed owner,
        address indexed basket,
        address keeper,
        uint256 cashPerRun,
        uint64 interval,
        uint64 auctionSecs,
        uint16 bandBps,
        uint256 minShares,
        uint256 maxShares
    );
    event PlanClosed(uint256 indexed id);
    event Instalment(
        uint256 indexed id,
        uint256 indexed orderId,
        address indexed caller,
        uint256 fairShares,
        uint256 startShares,
        uint256 endShares,
        uint32 run
    );

    error UnknownBasket();
    error ZeroAmount();
    error BadSchedule();
    error BandTooWide();
    error BadBounds();
    error NotOwner();
    error NotAllowed();
    error PlanClosedAlready();
    error TooSoon(uint256 nextRunAt);
    error FairOutOfBounds(uint256 fairShares, uint256 minShares, uint256 maxShares);

    constructor(CreationDeskV2 desk_) {
        desk = desk_;
        cash = desk_.cash();
    }

    // ------------------------------------------------------------------ views

    function planCount() external view returns (uint256) {
        return _plans.length;
    }

    function getPlan(uint256 id) external view returns (Plan memory) {
        return _plans[id];
    }

    function plansOf(address owner) external view returns (uint256[] memory) {
        return _plansOf[owner];
    }

    /// When the next instalment may run (0: now).
    function nextRunAt(uint256 id) public view returns (uint256) {
        Plan storage p = _plans[id];
        return p.runs == 0 ? 0 : uint256(p.lastRunAt) + p.interval;
    }

    /// The auction an instalment at `fairShares` would post.
    function auctionFor(uint256 id, uint256 fairShares) external view returns (uint256 startShares, uint256 endShares) {
        Plan storage p = _plans[id];
        _checkFair(p, fairShares);
        return SheafAuction.bounds(fairShares, p.bandBps, p.minShares);
    }

    // -------------------------------------------------------------- mutations

    /// Open a plan with the caller as owner. `keeper` may be zero (only the
    /// owner, or a key signing for the owner, can run it).
    function openPlan(
        address basket,
        uint256 cashPerRun,
        uint64 interval,
        uint64 auctionSecs,
        uint16 bandBps,
        uint256 minShares,
        uint256 maxShares,
        address keeper
    ) external nonReentrant returns (uint256 id) {
        if (!desk.factory().isBasket(basket)) revert UnknownBasket();
        if (cashPerRun == 0) revert ZeroAmount();
        if (interval == 0 || auctionSecs == 0 || auctionSecs > desk.MAX_ORDER_SECS()) revert BadSchedule();
        if (bandBps > SheafAuction.MAX_BAND_BPS) revert BandTooWide();
        if (minShares == 0 || minShares > maxShares) revert BadBounds();

        id = _plans.length;
        _plans.push(
            Plan({
                owner: msg.sender,
                interval: interval,
                runs: 0,
                active: true,
                basket: basket,
                lastRunAt: 0,
                keeper: keeper,
                auctionSecs: auctionSecs,
                bandBps: bandBps,
                cashPerRun: cashPerRun.toUint128(),
                minShares: minShares.toUint128(),
                maxShares: maxShares.toUint128()
            })
        );
        _plansOf[msg.sender].push(id);
        emit PlanOpened(id, msg.sender, basket, keeper, cashPerRun, interval, auctionSecs, bandBps, minShares, maxShares);
    }

    /// Stop a plan for good. Orders already posted stay on the desk; the owner
    /// can cancel them there, and anyone can once they expire.
    function closePlan(uint256 id) external nonReentrant {
        Plan storage p = _plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (!p.active) revert PlanClosedAlready();
        p.active = false;
        emit PlanClosed(id);
    }

    /// Run one instalment at `fairShares`, the caller's fair share count for
    /// one run's cash, which must sit inside the owner's bounds. Pulls exactly
    /// `cashPerRun` from the owner and posts the auction on the desk.
    function instalment(uint256 id, uint256 fairShares) external nonReentrant returns (uint256 orderId) {
        Plan storage p = _plans[id];
        address owner = p.owner;
        if (msg.sender != owner && (p.keeper == address(0) || msg.sender != p.keeper)) revert NotAllowed();
        if (!p.active) revert PlanClosedAlready();
        if (p.runs > 0) {
            uint256 next = uint256(p.lastRunAt) + p.interval;
            if (block.timestamp < next) revert TooSoon(next);
        }
        _checkFair(p, fairShares);
        (uint256 startShares, uint256 endShares) = SheafAuction.bounds(fairShares, p.bandBps, p.minShares);

        uint32 run = p.runs + 1;
        p.runs = run;
        p.lastRunAt = uint64(block.timestamp);

        uint256 amount = p.cashPerRun;
        cash.safeTransferFrom(owner, address(this), amount);
        cash.forceApprove(address(desk), amount);
        uint64 nowTs = uint64(block.timestamp);
        orderId = desk.placeOrderFor(owner, p.basket, amount, startShares, endShares, nowTs, nowTs + p.auctionSecs);
        emit Instalment(id, orderId, msg.sender, fairShares, startShares, endShares, run);
    }

    function _checkFair(Plan storage p, uint256 fairShares) private view {
        if (fairShares < p.minShares || fairShares > p.maxShares) {
            revert FairOutOfBounds(fairShares, p.minShares, p.maxShares);
        }
    }
}
