// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Sheaf testnet dollar mirror
/// @notice A 6-decimal stand-in for a dollar stablecoin on testnets where the
/// creation desk has no real stablecoin to settle in. It is worth nothing.
/// Anyone can mint up to `MAX_MINT_PER_CALL` per call.
contract MockDollar is ERC20 {
    /// 10,000 dollars per call.
    uint256 public constant MAX_MINT_PER_CALL = 10_000e6;
    bool public constant isMirror = true;

    error MintCapExceeded(uint256 requested, uint256 cap);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Mint `amount` to the caller.
    function faucet(uint256 amount) external {
        _faucet(msg.sender, amount);
    }

    /// Mint `amount` to `to`. Same cap as `faucet`.
    function mint(address to, uint256 amount) external {
        _faucet(to, amount);
    }

    function _faucet(address to, uint256 amount) private {
        if (amount > MAX_MINT_PER_CALL) revert MintCapExceeded(amount, MAX_MINT_PER_CALL);
        _mint(to, amount);
    }
}
