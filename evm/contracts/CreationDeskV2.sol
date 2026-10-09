// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Basket} from "./Basket.sol";
import {SheafFactory} from "./SheafFactory.sol";
import {SheafAuction} from "./SheafAuction.sol";

/// @title Sheaf creation desk, v2
/// @notice Cash creations by Dutch auction, with the protocol fee, the same
/// desk the Solana program runs.
///
/// A buyer escrows a fixed amount of a dollar stablecoin and posts a falling
/// share count: the shares they must receive start at `startShares` and decay
/// linearly to `endShares` by `endTs`. Any filler who holds the components can
/// take the order at the current count. The desk pulls the components, mints
/// the shares in kind, hands the buyer at least the auction's count, sends the
/// protocol's 0.10% to the treasury, and pays the filler the escrow. The
/// basket's creator fee is charged by the basket itself, as on every mint.
///
/// The protocol fee and the treasury are immutable: every basket this desk
/// serves pays exactly `PROTOCOL_FEE_BPS` for as long as the desk exists.
/// There is no owner, no pause, no setter and no upgrade path. The v1 desk is
/// untouched and keeps working beside this one.
contract CreationDeskV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// The protocol's creation fee: 0.10% of the gross shares each fill creates.
    uint16 public constant PROTOCOL_FEE_BPS = 10;
    uint256 private constant BPS = 10_000;
    /// No order may close more than 30 days out.
    uint64 public constant MAX_ORDER_SECS = 30 days;

    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    /// Packed into five slots; placing an order writes four of them.
    struct Order {
        address buyer;
        uint64 startTs;
        Status status;
        address basket;
        uint64 endTs;
        uint128 cashAmount;
        /// Shares the buyer received; 0 until filled.
        uint128 sharesOut;
        uint128 startShares;
        uint128 endShares;
        address filler;
    }

    IERC20 public immutable cash;
    SheafFactory public immutable factory;
    address public immutable treasury;

    Order[] private _orders;

    event OrderPlaced(
        uint256 indexed id,
        address indexed buyer,
        address indexed basket,
        address payer,
        uint256 cashAmount,
        uint256 startShares,
        uint256 endShares,
        uint64 startTs,
        uint64 endTs
    );
    event OrderFilled(
        uint256 indexed id,
        address indexed filler,
        uint256 sharesToBuyer,
        uint256 grossShares,
        uint256 creatorFeeShares,
        uint256 protocolFeeShares,
        uint256 cashPaid
    );
    event OrderCancelled(uint256 indexed id, uint256 refund);
    event ProtocolFeePaid(address indexed basket, address indexed treasury, uint256 shares);

    error UnknownBasket();
    error ZeroAmount();
    error ZeroAddress();
    error BadAuctionShares();
    error BadAuctionWindow();
    error BandTooWide();
    error FairBelowFloor();
    error ShortCash(uint256 expected, uint256 received);
    error NotOpen();
    error Expired();
    error NotBuyer();

    constructor(IERC20 cash_, SheafFactory factory_, address treasury_) {
        if (address(cash_) == address(0) || address(factory_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        cash = cash_;
        factory = factory_;
        treasury = treasury_;
    }

    // ------------------------------------------------------------------ views

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// The shares the buyer must receive if the order is filled at `ts`.
    function sharesAt(uint256 id, uint256 ts) public view returns (uint256) {
        Order storage o = _orders[id];
        return SheafAuction.sharesAt(o.startShares, o.endShares, o.startTs, o.endTs, ts);
    }

    /// Gross shares a fill must create so the buyer nets `sharesOut` after the
    /// basket's creator fee and the protocol fee. Rounds up, so the buyer gets
    /// at least `sharesOut` (at most two raw units more).
    function grossFor(address basket, uint256 sharesOut) public view returns (uint256) {
        uint256 feeBps = uint256(Basket(basket).creatorFeeBps()) + PROTOCOL_FEE_BPS;
        return Math.mulDiv(sharesOut, BPS, BPS - feeBps, Math.Rounding.Ceil);
    }

    /// What a fill in this block would need: the buyer's share count, the gross
    /// shares created, and the raw component amounts the filler must have
    /// approved to this desk.
    function quoteFill(uint256 id)
        external
        view
        returns (uint256 sharesOut, uint256 grossShares, uint256[] memory amounts)
    {
        Order storage o = _orders[id];
        sharesOut = sharesAt(id, block.timestamp);
        grossShares = grossFor(o.basket, sharesOut);
        amounts = Basket(o.basket).previewMint(grossShares);
    }

    /// The auction a fair share count describes: see `SheafAuction.bounds`.
    function auctionBounds(uint256 fairShares, uint16 bandBps, uint256 minShares)
        external
        pure
        returns (uint256 startShares, uint256 endShares)
    {
        if (bandBps > SheafAuction.MAX_BAND_BPS) revert BandTooWide();
        return SheafAuction.bounds(fairShares, bandBps, minShares);
    }

    // -------------------------------------------------------------- mutations

    /// Escrow `cashAmount` and post an auction for shares of `basket`, with
    /// the caller as buyer.
    function placeOrder(
        address basket,
        uint256 cashAmount,
        uint256 startShares,
        uint256 endShares,
        uint64 startTs,
        uint64 endTs
    ) external nonReentrant returns (uint256 id) {
        return _place(msg.sender, basket, cashAmount, startShares, endShares, startTs, endTs);
    }

    /// The same, but the shares (and any refund) belong to `buyer`. The caller
    /// pays the cash. A plan desk uses this to place a plan owner's instalment.
    function placeOrderFor(
        address buyer,
        address basket,
        uint256 cashAmount,
        uint256 startShares,
        uint256 endShares,
        uint64 startTs,
        uint64 endTs
    ) external nonReentrant returns (uint256 id) {
        if (buyer == address(0)) revert ZeroAddress();
        return _place(buyer, basket, cashAmount, startShares, endShares, startTs, endTs);
    }

    /// The auction in its usual shape: the caller names a fair share count for
    /// the cash, a band and a length; the count starts at fair plus the band,
    /// starts now, and ends at fair minus the band, never below `minShares`.
    function placeAuction(
        address basket,
        uint256 cashAmount,
        uint256 fairShares,
        uint16 bandBps,
        uint64 auctionSecs,
        uint256 minShares
    ) external nonReentrant returns (uint256 id) {
        if (bandBps > SheafAuction.MAX_BAND_BPS) revert BandTooWide();
        if (fairShares < minShares) revert FairBelowFloor();
        (uint256 startShares, uint256 endShares) = SheafAuction.bounds(fairShares, bandBps, minShares);
        uint64 nowTs = uint64(block.timestamp);
        return _place(msg.sender, basket, cashAmount, startShares, endShares, nowTs, nowTs + auctionSecs);
    }

    /// Deliver the components for an open order at the auction's current count
    /// and collect its cash. The filler must have approved this desk for the
    /// `amounts` that `quoteFill(id)` returns. The count only falls with time,
    /// so a fill that lands later never needs more than was quoted.
    function fill(uint256 id) external nonReentrant returns (uint256 sharesToBuyer) {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert NotOpen();
        if (block.timestamp > o.endTs) revert Expired();
        o.status = Status.Filled;
        o.filler = msg.sender;

        address basketAddr = o.basket;
        Basket basket = Basket(basketAddr);
        uint256 sharesOut = SheafAuction.sharesAt(o.startShares, o.endShares, o.startTs, o.endTs, block.timestamp);
        uint256 gross = grossFor(basketAddr, sharesOut);

        Basket.Component[] memory comps = basket.components();
        uint256[] memory amounts = basket.previewMint(gross);
        for (uint256 i; i < comps.length; ++i) {
            IERC20 token = IERC20(comps[i].token);
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            token.forceApprove(basketAddr, amounts[i]);
        }
        // The basket mints the creator's cut to the creator and the rest here.
        uint256 net = basket.mint(gross, address(this));
        uint256 protocolFee = Math.mulDiv(gross, PROTOCOL_FEE_BPS, BPS);
        sharesToBuyer = net - protocolFee;
        // gross >= sharesOut / (1 - fees), and both fees are floored.
        assert(sharesToBuyer >= sharesOut);
        o.sharesOut = sharesToBuyer.toUint128();

        IERC20 shares = IERC20(basketAddr);
        shares.safeTransfer(o.buyer, sharesToBuyer);
        if (protocolFee > 0) {
            shares.safeTransfer(treasury, protocolFee);
            emit ProtocolFeePaid(basketAddr, treasury, protocolFee);
        }
        uint256 paid = o.cashAmount;
        cash.safeTransfer(msg.sender, paid);
        emit OrderFilled(id, msg.sender, sharesToBuyer, gross, gross - net, protocolFee, paid);
    }

    /// The buyer can cancel an open order at any time. After the auction ends
    /// anyone can, and the cash always goes back to the buyer.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert NotOpen();
        if (msg.sender != o.buyer && block.timestamp <= o.endTs) revert NotBuyer();
        o.status = Status.Cancelled;
        uint256 refund = o.cashAmount;
        cash.safeTransfer(o.buyer, refund);
        emit OrderCancelled(id, refund);
    }

    // --------------------------------------------------------------- internal

    function _place(
        address buyer,
        address basket,
        uint256 cashAmount,
        uint256 startShares,
        uint256 endShares,
        uint64 startTs,
        uint64 endTs
    ) private returns (uint256 id) {
        if (!factory.isBasket(basket)) revert UnknownBasket();
        if (cashAmount == 0) revert ZeroAmount();
        if (endShares == 0 || startShares < endShares) revert BadAuctionShares();
        if (startTs >= endTs || endTs <= block.timestamp || endTs - block.timestamp > MAX_ORDER_SECS) {
            revert BadAuctionWindow();
        }

        // Refuse a cash token that skims on transfer: the escrow must hold
        // exactly what the filler will be paid.
        uint256 before = cash.balanceOf(address(this));
        cash.safeTransferFrom(msg.sender, address(this), cashAmount);
        uint256 received = cash.balanceOf(address(this)) - before;
        if (received != cashAmount) revert ShortCash(cashAmount, received);

        id = _orders.length;
        _orders.push(
            Order({
                buyer: buyer,
                startTs: startTs,
                status: Status.Open,
                basket: basket,
                endTs: endTs,
                cashAmount: cashAmount.toUint128(),
                sharesOut: 0,
                startShares: startShares.toUint128(),
                endShares: endShares.toUint128(),
                filler: address(0)
            })
        );
        emit OrderPlaced(id, buyer, basket, msg.sender, cashAmount, startShares, endShares, startTs, endTs);
    }
}
