// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Basket} from "./Basket.sol";
import {SheafFactory} from "./SheafFactory.sol";

/// @title Sheaf creation desk
/// @notice Cash creations settled in USDG, the way an ETF's authorised
/// participants work, but open to anyone.
///
/// A buyer who holds no stock tokens escrows USDG for a number of basket
/// shares. Any participant who holds the components can fill the order: the
/// desk pulls the components from them, mints the shares in kind straight to
/// the buyer, and pays the participant the escrowed USDG. The basket itself
/// never touches cash, so its in-kind guarantees are unchanged.
contract CreationDesk is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        address buyer;
        address basket;
        uint96 expiry;
        uint256 shares;
        uint256 usdgAmount;
        Status status;
        address filler;
    }

    IERC20 public immutable usdg;
    SheafFactory public immutable factory;

    Order[] private _orders;

    event OrderPlaced(
        uint256 indexed id,
        address indexed buyer,
        address indexed basket,
        uint256 shares,
        uint256 usdgAmount,
        uint96 expiry
    );
    event OrderFilled(uint256 indexed id, address indexed filler, uint256 sharesDelivered);
    event OrderCancelled(uint256 indexed id);

    error UnknownBasket();
    error ZeroAmount();
    error BadExpiry();
    error NotOpen();
    error Expired();
    error NotBuyer();

    constructor(IERC20 usdg_, SheafFactory factory_) {
        usdg = usdg_;
        factory = factory_;
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// Escrow `usdgAmount` of USDG for `shares` (gross) of `basket`.
    function placeOrder(address basket, uint256 shares, uint256 usdgAmount, uint96 expiry)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (!factory.isBasket(basket)) revert UnknownBasket();
        if (shares == 0 || usdgAmount == 0) revert ZeroAmount();
        if (expiry <= block.timestamp) revert BadExpiry();

        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        id = _orders.length;
        _orders.push(Order(msg.sender, basket, expiry, shares, usdgAmount, Status.Open, address(0)));
        emit OrderPlaced(id, msg.sender, basket, shares, usdgAmount, expiry);
    }

    /// Deliver the components for an open order and collect its USDG. The
    /// filler must have approved this desk for `Basket.previewMint(shares)`.
    function fill(uint256 id) external nonReentrant returns (uint256 delivered) {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert NotOpen();
        if (block.timestamp > o.expiry) revert Expired();
        o.status = Status.Filled;
        o.filler = msg.sender;

        Basket basket = Basket(o.basket);
        Basket.Component[] memory comps = basket.components();
        uint256[] memory amounts = basket.previewMint(o.shares);
        for (uint256 i; i < comps.length; ++i) {
            IERC20 token = IERC20(comps[i].token);
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            token.forceApprove(address(basket), amounts[i]);
        }
        delivered = basket.mint(o.shares, o.buyer);

        usdg.safeTransfer(msg.sender, o.usdgAmount);
        emit OrderFilled(id, msg.sender, delivered);
    }

    /// The buyer can cancel an open order at any time. After expiry anyone can,
    /// and the USDG always goes back to the buyer.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert NotOpen();
        if (msg.sender != o.buyer && block.timestamp <= o.expiry) revert NotBuyer();
        o.status = Status.Cancelled;
        usdg.safeTransfer(o.buyer, o.usdgAmount);
        emit OrderCancelled(id);
    }
}
