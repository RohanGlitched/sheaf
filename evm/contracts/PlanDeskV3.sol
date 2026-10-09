// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CreationDeskV2} from "./CreationDeskV2.sol";
import {SheafAuction} from "./SheafAuction.sol";

/// @title Sheaf plan desk, v3: trailing bounds under a hard floor
/// @notice Recurring buys whose amount, schedule and price limits the owner writes
/// on chain, and that keep running when the price moves.
///
/// v2 bounded every run's fair share count by two numbers fixed at opening, so a
/// monthly plan stopped after a normal monthly move. v3 keeps two kinds of bound:
///
/// - **Hard bounds** (`hardMin`, `hardMax`, shares per run): the owner's own limits,
///   written at opening and changed only by the owner. `hardMin` is the price cap:
///   no run's fair count may be below it and no run's auction ever ends below it,
///   so no run ever buys fewer than `hardMin` shares for `cashPerRun`.
/// - **A trailing window** of ±`stepBps` around a reference count. The reference
///   starts at the owner's `refShares` and, at each instalment, moves to what the
///   previous run actually filled at (the shares the owner received), clamped into
///   the hard bounds. A run's fair count must sit inside the window *and* the hard
///   bounds. So a plan follows the market by up to one step per run, and never past
///   the owner's hard limits.
///
/// A filler with no competition can walk the reference down by up to the auction's
/// band per run (by always filling at the auction's end). The hard floor bounds
/// that walk: it can never take a run below `hardMin`. The owner can re-centre at
/// any time with `recenter`, which also resets the hard bounds.
///
/// The keeper that triggers `instalment` (on Tempo, an access key signing as the
/// owner, scoped to `cash.approve(this)` and `instalment` only) supplies the fair
/// count. `openPlan`, `recenter` and `closePlan` must stay outside its scope: a key
/// signing as the owner is `msg.sender == owner` here, so only the scope stops it
/// from rewriting the plan. On chains without access keys, the owner can name a
/// `keeper` that may call `instalment` against a standing allowance; the same
/// bounds hold.
contract PlanDeskV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 private constant BPS = 10_000;
    /// A trailing step wider than ±50% is refused.
    uint16 public constant MAX_STEP_BPS = 5_000;

    /// Packed into six slots.
    struct Plan {
        address owner;
        uint64 interval;
        uint32 runs;
        address basket;
        uint64 lastRunAt;
        uint16 bandBps;
        uint16 stepBps;
        address keeper;
        uint64 auctionSecs;
        bool active;
        uint128 cashPerRun;
        /// The centre of the trailing window, in shares per run.
        uint128 refShares;
        uint128 hardMin;
        uint128 hardMax;
        /// The desk order id of the last run, plus one (0: none since opening or re-centring).
        uint64 lastOrderPlusOne;
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
        uint16 stepBps,
        uint256 refShares,
        uint256 hardMin,
        uint256 hardMax
    );
    event PlanClosed(uint256 indexed id);
    /// The reference moved: to the last run's fill (`byOwner` false) or by the owner's `recenter`.
    event Recentered(uint256 indexed id, uint256 refShares, uint256 hardMin, uint256 hardMax, bool byOwner);
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
    error StepTooWide();
    error BadBounds();
    error NotOwner();
    error NotAllowed();
    error PlanClosedAlready();
    error TooSoon(uint256 nextRunAt);
    /// `low` and `high` are the effective bounds: the trailing window inside the hard bounds.
    error FairOutOfBounds(uint256 fairShares, uint256 low, uint256 high);

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

    /// The bounds the next instalment's fair count must sit in, with the reference
    /// already moved to the last run's fill if that run has filled.
    function windowOf(uint256 id) public view returns (uint256 refShares, uint256 low, uint256 high) {
        Plan storage p = _plans[id];
        refShares = _currentRef(p);
        (low, high) = _window(p, refShares);
    }

    /// The auction an instalment at `fairShares` would post.
    function auctionFor(uint256 id, uint256 fairShares) external view returns (uint256 startShares, uint256 endShares) {
        Plan storage p = _plans[id];
        (, uint256 low, uint256 high) = windowOf(id);
        if (fairShares < low || fairShares > high) revert FairOutOfBounds(fairShares, low, high);
        return SheafAuction.bounds(fairShares, p.bandBps, p.hardMin);
    }

    // -------------------------------------------------------------- mutations

    /// Open a plan with the caller as owner. `keeper` may be zero (only the owner,
    /// or a key signing for the owner, can run it).
    function openPlan(
        address basket,
        uint256 cashPerRun,
        uint64 interval,
        uint64 auctionSecs,
        uint16 bandBps,
        uint16 stepBps,
        uint256 refShares,
        uint256 hardMin,
        uint256 hardMax,
        address keeper
    ) external nonReentrant returns (uint256 id) {
        if (!desk.factory().isBasket(basket)) revert UnknownBasket();
        if (cashPerRun == 0) revert ZeroAmount();
        if (interval == 0 || auctionSecs == 0 || auctionSecs > desk.MAX_ORDER_SECS()) revert BadSchedule();
        if (bandBps > SheafAuction.MAX_BAND_BPS) revert BandTooWide();
        if (stepBps > MAX_STEP_BPS) revert StepTooWide();
        _checkBounds(refShares, hardMin, hardMax);

        id = _plans.length;
        _plans.push(
            Plan({
                owner: msg.sender,
                interval: interval,
                runs: 0,
                basket: basket,
                lastRunAt: 0,
                bandBps: bandBps,
                stepBps: stepBps,
                keeper: keeper,
                auctionSecs: auctionSecs,
                active: true,
                cashPerRun: cashPerRun.toUint128(),
                refShares: refShares.toUint128(),
                hardMin: hardMin.toUint128(),
                hardMax: hardMax.toUint128(),
                lastOrderPlusOne: 0
            })
        );
        _plansOf[msg.sender].push(id);
        emit PlanOpened(id, msg.sender, basket, keeper, cashPerRun, interval, auctionSecs, bandBps, stepBps, refShares, hardMin, hardMax);
    }

    /// Owner only: move the reference to `refShares` and reset the hard bounds.
    /// The last run's fill no longer moves the reference; the next fill will.
    function recenter(uint256 id, uint256 refShares, uint256 hardMin, uint256 hardMax) external nonReentrant {
        Plan storage p = _plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (!p.active) revert PlanClosedAlready();
        _checkBounds(refShares, hardMin, hardMax);
        p.refShares = refShares.toUint128();
        p.hardMin = hardMin.toUint128();
        p.hardMax = hardMax.toUint128();
        p.lastOrderPlusOne = 0;
        emit Recentered(id, refShares, hardMin, hardMax, true);
    }

    /// Stop a plan for good. Orders already posted stay on the desk; the owner
    /// can cancel them there, and anyone can once they end.
    function closePlan(uint256 id) external nonReentrant {
        Plan storage p = _plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (!p.active) revert PlanClosedAlready();
        p.active = false;
        emit PlanClosed(id);
    }

    /// Run one instalment at `fairShares`, the caller's fair share count for one
    /// run's cash. The reference first moves to the last run's fill (if it filled);
    /// then `fairShares` must sit inside the trailing window and the hard bounds.
    /// Pulls exactly `cashPerRun` from the owner and posts the auction on the desk.
    function instalment(uint256 id, uint256 fairShares) external nonReentrant returns (uint256 orderId) {
        Plan storage p = _plans[id];
        address owner = p.owner;
        if (msg.sender != owner && (p.keeper == address(0) || msg.sender != p.keeper)) revert NotAllowed();
        if (!p.active) revert PlanClosedAlready();
        if (p.runs > 0) {
            uint256 next = uint256(p.lastRunAt) + p.interval;
            if (block.timestamp < next) revert TooSoon(next);
        }

        // Trail the last fill.
        uint256 ref = _currentRef(p);
        if (ref != p.refShares) {
            p.refShares = ref.toUint128();
            emit Recentered(id, ref, p.hardMin, p.hardMax, false);
        }
        (uint256 low, uint256 high) = _window(p, ref);
        if (fairShares < low || fairShares > high) revert FairOutOfBounds(fairShares, low, high);
        (uint256 startShares, uint256 endShares) = SheafAuction.bounds(fairShares, p.bandBps, p.hardMin);

        uint32 run = p.runs + 1;
        p.runs = run;
        p.lastRunAt = uint64(block.timestamp);

        uint256 amount = p.cashPerRun;
        cash.safeTransferFrom(owner, address(this), amount);
        cash.forceApprove(address(desk), amount);
        uint64 nowTs = uint64(block.timestamp);
        orderId = desk.placeOrderFor(owner, p.basket, amount, startShares, endShares, nowTs, nowTs + p.auctionSecs);
        p.lastOrderPlusOne = (orderId + 1).toUint64();
        emit Instalment(id, orderId, msg.sender, fairShares, startShares, endShares, run);
    }

    // --------------------------------------------------------------- internal

    function _checkBounds(uint256 refShares, uint256 hardMin, uint256 hardMax) private pure {
        if (hardMin == 0 || hardMin > refShares || refShares > hardMax) revert BadBounds();
    }

    /// The reference: the last run's fill, clamped into the hard bounds, if that
    /// run has filled since the reference was last set; otherwise the stored one.
    function _currentRef(Plan storage p) private view returns (uint256) {
        uint256 plusOne = p.lastOrderPlusOne;
        if (plusOne == 0) return p.refShares;
        CreationDeskV2.Order memory o = desk.getOrder(plusOne - 1);
        if (o.status != CreationDeskV2.Status.Filled || o.sharesOut == 0) return p.refShares;
        uint256 filled = o.sharesOut;
        if (filled < p.hardMin) return p.hardMin;
        if (filled > p.hardMax) return p.hardMax;
        return filled;
    }

    function _window(Plan storage p, uint256 ref) private view returns (uint256 low, uint256 high) {
        low = Math.mulDiv(ref, BPS - p.stepBps, BPS);
        high = Math.mulDiv(ref, BPS + p.stepBps, BPS);
        if (low < p.hardMin) low = p.hardMin;
        if (high > p.hardMax) high = p.hardMax;
    }
}
