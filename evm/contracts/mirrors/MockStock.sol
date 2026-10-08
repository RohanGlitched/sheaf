// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Sheaf testnet stock mirror
/// @notice A stand-in for a tokenized stock on testnets where no real stock
/// token exists. It is worth nothing, represents nothing and is labelled as a
/// mirror in its name ("Tesla (Sheaf testnet mirror)").
///
/// Anyone can mint up to `MAX_MINT_PER_CALL` per call, so a demo user can get
/// components without an issuer. The cap only keeps a single call sane: the
/// token is free by design and must never be treated as having value.
contract MockStock is ERC20 {
    /// 100 whole shares of the mirrored stock per call.
    uint256 public constant MAX_MINT_PER_CALL = 100e18;
    bool public constant isMirror = true;

    error MintCapExceeded(uint256 requested, uint256 cap);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

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
