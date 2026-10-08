// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Basket} from "./Basket.sol";

/// @title Sheaf factory
/// @notice Anyone can publish a basket. The factory checks the recipe once and
/// deploys an immutable Basket for it at a deterministic address.
contract SheafFactory {
    uint256 public constant MAX_NAME_LEN = 32;
    uint256 public constant MAX_SYMBOL_LEN = 10;

    struct ComponentArg {
        address token;
        uint256 unitsPerShare;
        uint16 weightBps;
    }

    address[] private _baskets;
    mapping(address => bool) public isBasket;
    /// One symbol per creator, so a creator cannot shadow their own basket.
    mapping(address => mapping(bytes32 => address)) public basketOf;

    event BasketCreated(
        address indexed basket,
        address indexed creator,
        string name,
        string symbol,
        uint16 creatorFeeBps,
        uint256 componentCount
    );

    error BadName();
    error BadSymbol();
    error CreatorFeeTooHigh();
    error BadComponentCount();
    error ZeroToken();
    error ZeroUnits();
    error ZeroWeight();
    error DuplicateComponent(address token);
    error WeightsMustSumToOne(uint256 total);
    error SymbolTaken(address existing);

    function createBasket(
        string calldata name,
        string calldata symbol,
        uint16 creatorFeeBps,
        ComponentArg[] calldata args
    ) external returns (address basket) {
        uint256 nameLen = bytes(name).length;
        uint256 symLen = bytes(symbol).length;
        if (nameLen == 0 || nameLen > MAX_NAME_LEN) revert BadName();
        if (symLen == 0 || symLen > MAX_SYMBOL_LEN) revert BadSymbol();
        if (creatorFeeBps > 100) revert CreatorFeeTooHigh();
        uint256 n = args.length;
        if (n == 0 || n > 8) revert BadComponentCount();

        bytes32 symKey = keccak256(bytes(symbol));
        address existing = basketOf[msg.sender][symKey];
        if (existing != address(0)) revert SymbolTaken(existing);

        Basket.Component[] memory comps = new Basket.Component[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            ComponentArg calldata a = args[i];
            if (a.token == address(0)) revert ZeroToken();
            if (a.unitsPerShare == 0) revert ZeroUnits();
            if (a.weightBps == 0) revert ZeroWeight();
            for (uint256 j; j < i; ++j) {
                if (args[j].token == a.token) revert DuplicateComponent(a.token);
            }
            total += a.weightBps;
            comps[i] = Basket.Component(a.token, a.unitsPerShare, a.weightBps);
        }
        if (total != 10_000) revert WeightsMustSumToOne(total);

        bytes32 salt = keccak256(abi.encode(msg.sender, symKey));
        basket = address(new Basket{salt: salt}(name, symbol, msg.sender, creatorFeeBps, comps));

        _baskets.push(basket);
        isBasket[basket] = true;
        basketOf[msg.sender][symKey] = basket;

        emit BasketCreated(basket, msg.sender, name, symbol, creatorFeeBps, n);
    }

    function basketCount() external view returns (uint256) {
        return _baskets.length;
    }

    function allBaskets() external view returns (address[] memory) {
        return _baskets;
    }
}
