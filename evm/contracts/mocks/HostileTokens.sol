// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test-only token that calls back into an arbitrary target in the middle of
/// every transfer once armed. Used to prove the basket and the desk refuse
/// re-entry from a hostile component token.
contract ReentrantERC20 is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("Reentrant", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// Arm the hook: the next transfer between two non-zero addresses calls
    /// `target` with `payload` and bubbles any revert unchanged.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false;
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            armed = true;
        }
    }
}

/// Test-only token whose issuer can pause it or blocklist an address, the way
/// regulated tokens (including tokenised equities) commonly can.
contract PausableERC20 is ERC20 {
    bool public paused;
    mapping(address => bool) public blocked;

    error TokenPaused();
    error AddressBlocked(address account);

    constructor() ERC20("Pausable", "PAUSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address account, bool b) external {
        blocked[account] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert TokenPaused();
        if (blocked[from]) revert AddressBlocked(from);
        if (blocked[to]) revert AddressBlocked(to);
        super._update(from, to, value);
    }
}
