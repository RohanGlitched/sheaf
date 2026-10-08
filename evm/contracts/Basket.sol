// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Sheaf basket
/// @notice A permissionless, in-kind index basket of Robinhood Stock Tokens.
///
/// A basket is a fixed recipe: for one whole share, hand the vault
/// `unitsPerShare` raw units of each component and receive one share token.
/// Burn a share and the vault hands the components back, pro rata.
///
/// Everything settles in kind. The contract never reads a price, so a stale or
/// manipulated oracle cannot mis-price a mint or a redemption, and the vault can
/// never be under-collateralised: deposits round up and withdrawals round down,
/// so rounding dust always stays with the vault and every holder.
///
/// Robinhood Stock Tokens apply corporate actions (splits, dividends) through a
/// multiplier on the token, not by moving raw balances out of holders. A raw-unit
/// recipe is therefore untouched by corporate actions, and whatever accrues to
/// the token accrues to every share automatically.
///
/// The recipe is written once, at construction, and has no setter. There is no
/// owner, no pause and no upgrade path.
contract Basket is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// One whole share, in raw share units.
    uint256 public constant ONE_SHARE = 1e18;
    /// Creator fees are capped at 1% of the shares issued on each mint.
    uint16 public constant MAX_CREATOR_FEE_BPS = 100;
    uint256 public constant MAX_COMPONENTS = 8;

    struct Component {
        address token;
        /// Raw token units of this component backing one whole share.
        uint256 unitsPerShare;
        /// Target weight at creation, recorded so drift is measurable later.
        uint16 weightBps;
    }

    address public immutable factory;
    address public immutable creator;
    uint16 public immutable creatorFeeBps;
    uint64 public immutable createdAt;

    Component[] private _components;

    uint64 public mintCount;
    uint64 public redeemCount;

    event SharesMinted(
        address indexed payer,
        address indexed receiver,
        uint256 sharesIssued,
        uint256 creatorFeeShares,
        uint256[] amountsIn
    );
    event SharesRedeemed(address indexed owner, address indexed receiver, uint256 sharesBurned, uint256[] amountsOut);

    error ZeroShares();
    error DustMint();
    error ShortDeposit(address token, uint256 expected, uint256 received);

    /// @dev Validation of the recipe happens in the factory, which is the only
    /// deployer. Constructor arguments are trusted to have passed it.
    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        uint16 creatorFeeBps_,
        Component[] memory components_
    ) ERC20(name_, symbol_) {
        factory = msg.sender;
        creator = creator_;
        creatorFeeBps = creatorFeeBps_;
        createdAt = uint64(block.timestamp);
        for (uint256 i; i < components_.length; ++i) {
            _components.push(components_[i]);
        }
    }

    // ------------------------------------------------------------------ views

    function componentCount() external view returns (uint256) {
        return _components.length;
    }

    function components() external view returns (Component[] memory) {
        return _components;
    }

    /// Component amounts a mint of `shares` will pull. Rounds up.
    function previewMint(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _components.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(_components[i].unitsPerShare, shares, ONE_SHARE, Math.Rounding.Ceil);
        }
    }

    /// Component amounts a redemption of `shares` will pay out. Rounds down.
    function previewRedeem(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _components.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(_components[i].unitsPerShare, shares, ONE_SHARE, Math.Rounding.Floor);
        }
    }

    /// Shares the receiver nets from a mint of `shares`, after the creator fee.
    function previewNetShares(uint256 shares) public view returns (uint256 net, uint256 fee) {
        fee = Math.mulDiv(shares, creatorFeeBps, 10_000);
        net = shares - fee;
    }

    /// What the vault actually holds of each component. Anyone can compare this
    /// with `totalSupply` to check that every share is fully backed.
    function vaultBalances() external view returns (uint256[] memory balances) {
        uint256 n = _components.length;
        balances = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            balances[i] = IERC20(_components[i].token).balanceOf(address(this));
        }
    }

    // -------------------------------------------------------------- mutations

    /// Deposit the recipe in kind and mint `shares` (gross of the creator fee)
    /// to `receiver`. The caller must have approved this basket for every
    /// component amount returned by `previewMint(shares)`.
    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 net) {
        if (shares == 0) revert ZeroShares();
        uint256 n = _components.length;
        uint256[] memory amounts = previewMint(shares);

        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) revert DustMint();
            IERC20 token = IERC20(_components[i].token);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            // A token that skims on transfer would leave the vault short and
            // dilute every holder. Refuse it instead.
            uint256 received = token.balanceOf(address(this)) - before;
            if (received < amounts[i]) revert ShortDeposit(address(token), amounts[i], received);
        }

        // The creator's cut comes out of the shares issued, never out of the
        // vault, so backing per share is identical before and after.
        uint256 fee;
        (net, fee) = previewNetShares(shares);
        if (net == 0) revert ZeroShares();
        _mint(receiver, net);
        if (fee > 0) _mint(creator, fee);
        unchecked {
            ++mintCount;
        }

        emit SharesMinted(msg.sender, receiver, net, fee, amounts);
    }

    /// Burn `shares` from the caller and send the components to `receiver`.
    function redeem(uint256 shares, address receiver) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroShares();
        // Burn first: nothing leaves the vault until the shares are gone.
        _burn(msg.sender, shares);

        amounts = previewRedeem(shares);
        uint256 n = _components.length;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] > 0) IERC20(_components[i].token).safeTransfer(receiver, amounts[i]);
        }
        unchecked {
            ++redeemCount;
        }

        emit SharesRedeemed(msg.sender, receiver, shares, amounts);
    }
}
