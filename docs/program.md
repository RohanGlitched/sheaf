# The Sheaf program

Sheaf is an Anchor 0.31.1 program for permissionless, in-kind index baskets of
tokenized equities on Solana, plus an oracle-free cash desk and recurring buy
plans on top of them.

| | |
|---|---|
| Program ID (devnet) | `GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz` |
| Deployed | first deploy: devnet slot 508915971, tx `Af2eUxjUzrcYVRxuZMt3DdfKdv3w3PhZEpqxr4oD6bX6LvVac6YLhAc1wHxjwgHSK6ECh68uaPDmn93ya6qfdHG` |
| Hardening upgrade | devnet slot 509084920, tx `2ia49PHW3qtstt4LM1EocsYtKH6zVPd4NCcdZH7tsVtZkfsrF1eHvTzS1J8WW8p9wihgh872ZTxb4hrmczxKHt1b`; 517,800-byte program; upgrade authority `7md5ecBazJtGoHEkRvQaVSdNz7pyJrbmrHgx1L5NVJb4` (a single key: the program is upgradeable) |
| Real-issuer upgrade | devnet slot 509118619, tx `4BWEZTsENAXhe9GtFtX5uSN2x6teejqs8ya4z9w8dMj3wu5WLej9sA7BFQTvJDio2dCajeii5r8FN8P6udPpiGX7`; 515,664-byte build in the same 517,800-byte program account (no extend); on-chain IDL upgraded. Accepts real xStocks and PreStocks under their issuers (`KNOWN_ISSUERS`), refuses issuer powers held by anyone else, gates cash transfer-fee and hook authorities, refuses legacy SPL Token share mints. No account layout changed; existing baskets, orders and plans decode and work unchanged |
| Source | `programs/sheaf/src/lib.rs` |
| IDL | `target/idl/sheaf.json` (copied to `web/lib/sheaf-idl.json`; on chain at `Brx9QqE7Hzh9ReaoNvk9BMSM5Ci1U2C6qx6qukciugBS`, `anchor idl fetch`) |
| Tests | `tests/sheaf.ts` and `tests/mainnet-clone.ts` (integration, `anchor test`; the second runs against real mainnet xStock and PreStocks mints), `#[cfg(test)]` unit tests in `lib.rs` (`cargo test -p sheaf --lib`) |

The program never reads a price. Baskets are minted and redeemed in kind, so
the vault can never back a share by less than its recipe. The desk turns cash
into shares through a Dutch auction that fillers compete on, and a plan's
reference rate is learned from its own fills, so there is no oracle anywhere.

---

## 1. Concepts and units

- **Share**: a Token-2022 token with 6 decimals. `ONE_SHARE = 1_000_000` raw units.
- **Component**: a tokenized stock: a real xStock or PreStocks mint, or any
  mint whose issuer powers are empty or held by a known issuer (§8).
- **Recipe**: per component, `units_per_share` raw units of that component back
  one whole share. Up to 8 components, all on one token program.
- **Creator fee**: `creator_fee_bps <= 100` (1%), taken in newly minted shares,
  never out of the vault, so backing per share is unchanged by it.
- **Cash**: any SPL Token or Token-2022 mint that cannot seize, freeze or
  block an escrow (§8). USDC qualifies. A mint with a permanent delegate,
  such as PYUSD, does not.
- **Reference rate** (plans): `ref_shares_per_cash_e9` = raw share units per raw
  cash unit, times 10^9. With 6-decimal cash and 6-decimal shares, a share price
  of P cash per share means `ref = 10^9 / P`. For example, $250 a share gives
  `4_000_000`.

---

## 2. Accounts and PDAs

| Account | Seeds | Created by | Closed by |
|---|---|---|---|
| `Basket` | `["basket", creator, symbol]` | `create_basket` | never |
| Component vault | ATA of the basket PDA for each component mint (canonical; checked by `verify_vault`) | the client (idempotent ATA create) | never |
| `Order` (user) | `["order", basket, buyer, nonce_le_u64]` | `place_order` | `fill_order`, `cancel_order` |
| `Order` (plan) | `["plan_order", plan, nonce_le_u64]`. Plan orders placed before the hardening release used the user form; the program signs for either | `run_plan` | `fill_order`, `cancel_order` |
| Order escrow | ATA of the **order PDA** for the cash mint, under the cash token program | same instruction as the order (`init_if_needed`) | same instruction as the order |
| `Plan` | `["plan", basket, owner, plan_id_le_u64]` | `open_plan` | `close_plan` (`close_legacy_plan` for a pre-hardening plan) |

### `Basket`

`creator, share_mint, token_program, name (<=32), symbol (<=10), creator_fee_bps,
component_count, components[8] {mint, units_per_share, weight_bps, decimals},
created_at, mint_count, redeem_count, bump`.

### `Order`

| Field | Meaning |
|---|---|
| `basket` | basket whose shares are being bought |
| `buyer` | receives the shares (in their canonical share ATA) and any refund |
| `rent_payer` | paid the order's and escrow's rent and gets both back on close: the buyer for `place_order`, the cranker for `run_plan` |
| `cash_mint`, `cash_token_program` | the cash being paid |
| `plan` | `Some(plan)` if a plan placed the order |
| `nonce` | caller-chosen, part of the seeds (each namespace has its own) |
| `cash_amount` | cash **actually received** into escrow (net of any Token-2022 transfer fee) |
| `start_shares`, `end_shares` | shares the buyer receives at `start_ts` and at `end_ts`; `start_shares >= end_shares > 0` |
| `start_ts`, `end_ts` | auction window, unix seconds; `start_ts < end_ts` |
| `created_at`, `bump` | |

### `Plan`

| Field | Meaning |
|---|---|
| `owner`, `basket` | |
| `cash_mint`, `cash_token_program`, `cash_account` | the owner's cash account the plan is the SPL delegate of |
| `plan_id` | owner-chosen, part of the seeds |
| `cash_per_run`, `period_secs`, `runs_total`, `runs_left`, `next_run_ts` | schedule |
| `ref_shares_per_cash_e9` | reference rate; replaced by the filled rate after every plan fill, clamped to `[min, max]` |
| `band_bps` | half-width of each run's auction around the reference, `<= 5000` |
| `auction_secs` | length of each run's auction |
| `last_order` | most recent order the plan placed |
| `fills`, `last_fill_ts` | how many plan orders have filled, and when the last one did |
| `created_at`, `bump` | |
| `min_ref_shares_per_cash_e9` | the owner's floor: no run's auction ends below `cash × min / 10^9` shares, and fills never move the reference under it |
| `max_ref_shares_per_cash_e9` | the ceiling fills can push the reference to |

**Layout change.** The hardening release appended the two bounds, so a
`Plan` is now 296 bytes. A 280-byte plan written by the first release no
longer decodes as `Plan`: `run_plan`, `close_plan` and `update_plan` refuse
it (`AccountDidNotDeserialize`), a fill of one of its open orders still
succeeds and simply leaves it alone, and its owner closes it with
`close_legacy_plan`. `Basket` and `Order` are byte-for-byte unchanged.

---

## 3. Instructions

### `create_basket(name, symbol, creator_fee_bps, components)`

Signer `creator` pays. `remaining_accounts` = each component mint, in order.
Weights must sum to 10,000 bps, and components must be distinct.

**Share mint.** It must be owned by a token program (`ShareMintProgram`),
and that program must be Token-2022 (`ShareMintNotToken2022`): every client
derives share accounts under Token-2022, so a legacy SPL Token share mint is
refused. It must decode as a real, initialised mint (`MalformedMint`,
which rejects a token account that merely happens to be long enough). It must
have 6 decimals, zero supply, mint authority = the basket PDA and no freeze
authority. It may carry **only** `MetadataPointer` and `TokenMetadata`
(`ShareMintExtension`). Every other extension, including any the program
doesn't recognise, is refused, because each one gives somebody a lever over
holders' shares:

| Extension | What it would let its authority do |
|---|---|
| PermanentDelegate | transfer or burn anyone's shares, then redeem the vault |
| Pausable | block burns, and so every redemption |
| TransferHook | block secondary transfers |
| MintCloseAuthority | close the mint at zero supply and re-create it under a new authority |
| ScaledUiAmount, InterestBearing | change what wallets display |
| NonTransferable, DefaultAccountState, ConfidentialTransfer | change what holders can do |

**Components.** Each must be owned by `component_token_program` and decode as
a real mint. Always accepted: `MetadataPointer`, `TokenMetadata`, group
pointer and member, `ScaledUiAmount` (display only), `TransferFeeConfig` (a
deposit grosses up for it, and a fee can never stop a transfer), and
`DefaultAccountState` when the default is *initialised*.

**Issuer powers** are accepted only when every authority on them is empty or
in `KNOWN_ISSUERS` (`ComponentIssuerAuthority` otherwise), because each one is
a lever over the vault:

| Power | Authority checked | What it could do to a basket |
|---|---|---|
| Freeze authority | the mint's freeze authority | freeze the vault, blocking every redemption |
| `PermanentDelegate` | the delegate | move or burn vault balances |
| `Pausable` | the pause authority | block every transfer, so every redemption |
| `ConfidentialTransferMint`, `ConfidentialTransferFeeConfig` | the config authority | reconfigure confidential transfers |
| `TransferHook` with no program set | the hook authority | set a hook program later, which bricks the basket (hook accounts aren't forwarded) |

Every real xStock and PreStock carries all of these, held by its issuer:

| Key | Holds |
|---|---|
| `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` (Backed, xStocks) | permanent delegate, confidential-transfer, transfer-hook and metadata authority on every xStock |
| `JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs` (Backed, xStocks) | pause and freeze authority on every xStock |
| `WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc` (PreStocks) | every authority on every PreStocks mint |
| `B8dLfY9rokrZwq7ae1CuVfi8deSoeywgJGiS3W2U9U1L` (write cluster only) | the stand-in issuer that mints the devnet mirrors and the test dollar; left out of a build with the `mainnet` feature |

The mainnet keys were read with `getAccountInfo` (jsonParsed) from all 20
xStocks and 8 PreStocks the app lists (`web/lib/universe.ts`,
`web/lib/prestocks.ts`); every one carries exactly these authorities. Backed's
mint authority (`7pt9tkct…`) and ScaledUiAmount authority (`S7vYFFWH…`) are
not in the list because those powers are not checked: minting cannot touch a
vault, and the multiplier changes only what wallets display.

Refused outright (`ComponentMintExtension`), whoever holds it, along with
anything unrecognised: a `TransferHook` with a program set, a frozen default
state, `NonTransferable`, and `MintCloseAuthority`.

The `spl-token-2022` crate this program builds against predates
`ScaledUiAmount` (25) and `Pausable` (26), so the program walks the
Token-2022 TLV area by extension number (`for_each_mint_extension`) and
fails closed on anything it doesn't know. The transfer-fee gross-up reads
`TransferFeeConfig` the same way: the crate's own lookup stops at the first
extension it doesn't know, so on a mint that lists `Pausable` or
`ScaledUiAmount` before its fee config it would silently skip the fee.

### `mint_shares(shares)`

The depositor transfers, per component,
`ceil(units_per_share × shares / 10^6)`, grossed up for any `TransferFeeConfig`
so the vault nets exactly that. They receive `shares − fee`, and the creator
receives `fee = floor(shares × creator_fee_bps / 10^4)`, into an account the
basket creator owns.
`remaining_accounts` = `[component_mint, depositor_token_account, basket_vault_ata]` per component.

Every issuance (here and in `fill_order`) re-checks the share mint's
extensions, and every deposit re-checks each component's. A basket created
before those checks existed therefore can't take in new value it could lose.
Redemption is never gated, so holders can always exit.

### `redeem_shares(shares)`

Unchanged. Burns first, then pays `floor(units_per_share × shares / 10^6)` of
each component out of the vault.
`remaining_accounts` = `[component_mint, basket_vault_ata, recipient_token_account]` per component.

### `place_order(nonce, cash_amount, start_shares, end_shares, start_ts, end_ts)`

| Account | Constraint |
|---|---|
| `buyer` | signer, pays rent |
| `basket` | a `Basket` |
| `order` | `init`, seeds `["order", basket, buyer, nonce]` |
| `cash_mint` | owned by `cash_token_program` |
| `buyer_cash_account` | mint = `cash_mint`, **owner = buyer** |
| `escrow` | `init_if_needed` ATA (mint = `cash_mint`, authority = `order`) |
| `cash_token_program`, `associated_token_program`, `system_program` | |

Checks:

- `cash_amount > 0`, `end_shares > 0`, `start_shares >= end_shares`.
- `start_ts < end_ts`, `end_ts > now`, and `end_ts <= now + 30 days`
  (`MAX_ORDER_SECS`), so no one's cash or rent can be parked for a century.
- The cash mint passes the cash policy (`CashMintExtension`,
  `CashMintAuthority`, §8).

It moves `cash_amount` into escrow and
records the escrow's balance delta as `order.cash_amount`. Fills before
`start_ts` are allowed, at `start_shares`, which is the best price the buyer
offered. Emits `OrderPlaced`.

### `fill_order()`

Permissionless.

| Account | Constraint |
|---|---|
| `filler` | signer; authority over the component source accounts |
| `order` | `has_one` basket, buyer, rent_payer, cash_mint; closed to `rent_payer` |
| `basket` | mut |
| `share_mint` | = `basket.share_mint` |
| `buyer` | = `order.buyer` |
| `buyer_share_account` | **the buyer's canonical share ATA** (associated-token constraint) |
| `creator_share_account` | optional; required if any fee shares are owed; mint = share mint, **owner = basket creator** |
| `cash_mint` | mut (a withheld transfer fee may be harvested to it) |
| `escrow` | the order PDA's ATA |
| `filler_cash_account` | any account of the cash mint (the filler signs, so it is theirs to choose) |
| `rent_payer` | = `order.rent_payer` |
| `plan` | optional; **required and pinned** when `order.plan` is set |
| `share_token_program`, `component_token_program`, `cash_token_program` | |
| `remaining_accounts` | `[component_mint, filler_token_account, basket_vault_ata]` per component, exactly as in `mint_shares` |

Steps:

1. `require!(now <= end_ts)`, else `OrderExpired`. Then
   `require!(escrow.amount >= order.cash_amount)`, else `EscrowShort`. The
   filler is about to deliver stocks against `cash_amount`, so the cash must
   really be there. For orders placed after this release the cash policy
   already makes a short escrow impossible; the check guards anything older.
2. `received = required_shares(now)` (§4).
3. `gross = gross_shares_for_net(received, creator_fee_bps)` (§5), `fee = gross − received`.
4. `deposit_components(gross)`: the same function `mint_shares` uses, so the
   rounding, transfer-fee gross-up, component-mint and vault checks are identical.
5. Mint `received` to the buyer's share ATA and `fee` to the creator.
6. Only then is the cash released: the whole escrow balance goes to the filler,
   any withheld Token-2022 fee is harvested to the mint, the escrow is closed,
   and the order is closed. Both rents go to `rent_payer`.
   *Surplus:* the balance is at least `cash_amount`, and anything above it is
   a third party's donation. The buyer funds exactly `cash_amount`, measured
   by balance delta, and a pre-existing balance is never counted as theirs.
   It goes to the filler with the rest, which closes the escrow without a
   fourth token account. `OrderFilled.cash_paid` reports the total.
7. If the order came from a plan that still exists, decodes under the current
   layout, matches basket, owner and cash mint, and is the **same
   incarnation** (`order.created_at >= plan.created_at`, so an order left
   over from a plan that was closed and reopened under the same id can't
   steer the new one), set
   `plan.ref_shares_per_cash_e9 = clamp(floor(received × 10^9 / order.cash_amount), min, max)`.
   The one blind spot is a close and reopen within the same second.
8. Increment `basket.mint_count`. Emit `SharesMinted` (with depositor = filler,
   so supply can still be rebuilt from events alone) and `OrderFilled`.

**Semantics chosen:** the auction's share count is what the buyer **receives**.
The filler delivers components for `gross` shares, and the creator fee is exactly
`mint_shares`' fee on what was delivered: `floor(gross × bps / 10^4) = gross − received`.

### `cancel_order()`

| Account | Constraint |
|---|---|
| `caller` | signer |
| `order` | `has_one` buyer, rent_payer, cash_mint; closed to `rent_payer` |
| `buyer` | = `order.buyer` |
| `cash_mint`, `escrow` | as in fill |
| `buyer_cash_account` | mint = cash mint, **owner = buyer** |
| `rent_payer` | = `order.rent_payer` |
| `cash_token_program` | |

`caller == buyer` may cancel at any time. Anyone may cancel once `now > end_ts`.
The windows don't overlap: a fill is valid while `now <= end_ts`, and a
stranger's cancel only when `now > end_ts`. The refund always goes to an account
the buyer owns. Emits `OrderCancelled { expired }`.

### `open_plan(plan_id, cash_per_run, period_secs, runs, ref_shares_per_cash_e9, band_bps, auction_secs, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9)`

| Account | Constraint |
|---|---|
| `owner` | signer, pays rent |
| `basket` | a `Basket` |
| `plan` | `init`, seeds `["plan", basket, owner, plan_id]` |
| `cash_mint` | owned by `cash_token_program` |
| `owner_cash_account` | mint = cash mint, owner = `owner` |
| `cash_token_program`, `system_program` | |

Checks (`validate_plan_terms`, shared with `update_plan`):

- `cash_per_run > 0`, `period_secs > 0`, `runs > 0`, and
  `0 < auction_secs <= 30 days` (`BadPlanSchedule`).
- `ref > 0` (`BadReferenceRate`) and `0 < min <= ref <= max` (`BadReferenceBounds`).
- `band_bps <= 5000` (`BandTooWide`).
- The first run's `end_shares > 0`.
- The cash mint passes the cash policy (`CashMintExtension`, `CashMintAuthority`).
- `cash_per_run × runs` doesn't overflow.

If the cash account already has a
different delegate with a non-zero allowance, the instruction fails with
`DelegateInUse` instead of silently replacing it (the client may prepend a
`revoke` if that is what the owner wants). Then the program CPIs
`approve_checked(owner_cash_account → plan PDA, cash_per_run × runs)` under the
owner's signature, so opening the plan and approving it is one instruction.
`next_run_ts = now`, so the first run can happen immediately. Emits `PlanOpened`.

### `update_plan(ref_shares_per_cash_e9, band_bps, auction_secs, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9)`

| Account | Constraint |
|---|---|
| `owner` | signer, = `plan.owner` (`PlanAccountMismatch` otherwise) |
| `plan` | mut, `has_one owner` |

Owner only. It re-centres a plan under exactly `open_plan`'s rules: the
reference, band, auction length and both bounds. This is how an owner
un-sticks a plan the market has moved away from (no filler will touch an
auction that is entirely out of the market, so its reference would never
move on its own), or tightens a plan after a fill they didn't like. The
schedule, remaining runs and allowance are untouched. Orders already
placed keep their own terms. Emits `PlanUpdated`.

### `run_plan(nonce)`

Permissionless crank.

| Account | Constraint |
|---|---|
| `cranker` | signer, pays the order and escrow rent and gets it back when the order closes |
| `plan` | mut, `has_one cash_mint` |
| `order` | `init`, seeds `["plan_order", plan, nonce]`. This is a namespace of its own, so a cranker can't take a nonce the owner is about to use for `place_order` |
| `cash_mint` | = `plan.cash_mint`, owned by `cash_token_program` |
| `owner_cash_account` | = `plan.cash_account` |
| `escrow` | `init_if_needed` ATA of the order |
| `cash_token_program`, `associated_token_program`, `system_program` | |

Checks: `runs_left > 0` (`PlanExhausted`), then `now >= next_run_ts`
(`PlanTooEarly`). The plan PDA signs a `transfer_checked` of `cash_per_run`
from the owner's account as its SPL delegate, and the token program enforces
and decrements the allowance. With `cash` = what escrow actually received:

```
band_start   = floor(cash × ref × (10_000 + band) / (10^9 × 10_000))
band_end     = floor(cash × ref × (10_000 − band) / (10^9 × 10_000))
floor        = floor(cash × min_ref / 10^9)
end_shares   = max(band_end, floor)
start_shares = max(band_start, end_shares)
window       = [now, now + auction_secs]
```

The order is written with `buyer = plan.owner`, `rent_payer = cranker` and
`plan = Some(plan)`. Then `runs_left -= 1`, `last_order = order`, and
`next_run_ts += period_secs`. If the crank was so late that this is still
`<= now`, `next_run_ts = now + period_secs`: missed slots are not replayed in
a burst, and no run is lost. Emits `OrderPlaced` and `PlanRun`.

### `close_plan()`

| Account | Constraint |
|---|---|
| `owner` | signer, = `plan.owner`, receives the plan's rent |
| `plan` | `has_one owner`, closed |
| `owner_cash_account` | = `plan.cash_account` (decoded leniently, since it may have been closed) |
| `cash_token_program` | = `plan.cash_token_program` |

If the cash account still exists, is still owned by the plan owner, and still
names this plan as its delegate, the program CPIs `revoke` under the owner's
signature. Otherwise it skips the revoke rather than fail, so a plan can always
be closed. Orders the plan already placed stay open. They can still be filled
(the closed plan is simply not updated) or cancelled. Emits `PlanClosed { revoked }`.

### `close_legacy_plan()`

| Account | Constraint |
|---|---|
| `owner` | signer, mut; must equal the owner recorded in the plan bytes |
| `plan` | mut; owned by this program, exactly 280 bytes, `Plan` discriminator (`NotLegacyPlan` otherwise) |
| `owner_cash_account` | must equal the plan's recorded cash account |
| `cash_token_program` | must equal the plan's recorded cash token program |

This closes a plan written by the first release, which today's `Plan`
can't decode. The handler checks every byte it relies on, revokes the
allowance the same way `close_plan` does, returns the rent to the owner,
and hands the account back to the system program. Emits `PlanClosed`.
Rehearsed locally: the old binary created a plan plus a plan order and a
user order, the program was upgraded in place to this release, and then
both orders filled under their original seeds, `run_plan` and `close_plan`
refused the old plan, and `close_legacy_plan` closed it and revoked its
allowance. `tests/mainnet-clone.ts` now covers the success path on every
run, against a 280-byte first-release plan loaded as a validator fixture.

---

## 4. Auction math

```
required(now) = start_shares                                   if now <= start_ts
              = end_shares                                     if now >= end_ts
              = start_shares − floor((start_shares − end_shares) × (now − start_ts)
                                     / (end_ts − start_ts))     otherwise
```

- The decay is rounded **down**, so between the endpoints the buyer gets the
  rounding and never receives fewer shares than the exact line.
- The arithmetic is widened to i128/u128, so no choice of timestamps can
  overflow it (a unit test checks `start_ts = i64::MIN, end_ts = i64::MAX`).
- `required` is monotone non-increasing in `now` and always within
  `[end_shares, start_shares]` (unit-tested across a whole window).

### Worked example

A buyer escrows **250 USDC** (`250_000_000` raw) for MAG3, a 3-component basket
with a 0.30% creator fee and a recipe of 15,000,000 / 9,000,000 / 4,000,000 raw
units per share. The auction runs from `start_shares = 2_000_000` (2 shares, or
125 USDC each) to `end_shares = 1_000_000` (1 share, 250 USDC) over
`start_ts = 1000` to `end_ts = 1100`.

A filler fills at `now = 1037`:

1. Decay = `floor(1_000_000 × 37 / 100) = 370_000`, so the buyer receives
   `2_000_000 − 370_000 = 1_630_000` (1.63 shares).
2. Gross-up for the 30 bps fee: `ceil(1_630_000 × 10_000 / 9_970) = 1_634_905`,
   which nets 1,630,001. One step down, `1_634_904`, nets
   `1_634_904 − floor(1_634_904 × 30 / 10_000) = 1_634_904 − 4_904 = 1_630_000`
   exactly, and `1_634_903` would net 1,629,999. So `gross = 1_634_904` and the
   creator gets 4,904 fee shares.
3. The filler deposits `ceil(units × 1_634_904 / 10^6)`: **24,523,560**,
   **14,714,136** and **6,539,616** raw units of the three components.
4. The buyer receives 1,630,000 shares, the creator 4,904, and the filler
   250,000,000 raw USDC.
5. `OrderFilled.price = floor(250_000_000 × 10^6 / 1_630_000) = 153_374_233`,
   i.e. 153.374233 USDC per share.

The filler fills when the components are worth less than 250 USDC to them. As
time passes, the buyer asks for fewer shares, so the first filler for whom the
deal clears takes it. That is the price discovery, and no oracle is involved.

### Plan example

A plan with `cash_per_run = 100 USDC`, `ref = 4_000_000` (250 USDC a share) and
`band_bps = 300`:

- Run 1: `start = floor(10^8 × 4×10^6 × 10_300 / 10^13) = 412_000`, `end = 388_000`.
- It fills at 401,234 shares, so the new `ref = floor(401_234 × 10^9 / 10^8) = 4_012_340`.
- Run 2: `start = 413_271`, `end = 389_196`.

With `band_bps = 3000` and an owner floor `min_ref = 3_600_000` ($277.78 a
share), the band alone would end the auction at 280,000 shares. The floor
lifts it to `floor(10^8 × 3.6×10^6 / 10^9) = 360_000`, so the worst a run
can fill at is the owner's own limit. Before this release, n runs of
uncontested end-of-auction fills walked the reference down as
`ref × (1 − band)^n`. Now each step lands at or above the floor, and the
unit test `plan_floor_bounds_the_auction` runs 50 such steps at a 50% band
and ends exactly at the floor.

---

## 5. Creator-fee gross-up

`gross_shares_for_net(net, bps)` returns the smallest `g` with
`g − floor(g × bps / 10^4) >= net`. Because the net of `g` grows by 0 or 1 per
unit of `g`, that `g` nets **exactly** `net`. The program starts at
`ceil(net × 10^4 / (10^4 − bps))`, which can overshoot by at most 2 because the
fee is floored, and steps down at most 3 times. It then asserts the exact-net
property, so a wrong answer fails the instruction rather than mis-issuing
shares. A unit test checks exactness and minimality for every `net` in
`1..20_000` and several large values, at fees of 0, 1, 7, 30, 99 and 100 bps.

---

## 6. Events

| Event | Fields |
|---|---|
| `BasketCreated` | basket, creator, share_mint, name, symbol, component_count |
| `SharesMinted` | basket, depositor, shares_issued, creator_fee_shares, amounts[8]. Emitted by `mint_shares` **and** `fill_order` (depositor = filler) |
| `SharesRedeemed` | basket, owner, shares_burned, amounts[8] |
| `OrderPlaced` | order, basket, buyer, plan?, cash_mint, nonce, cash_amount, start_shares, end_shares, start_ts, end_ts. Emitted by `place_order` and `run_plan` |
| `OrderFilled` | order, basket, buyer, filler, plan?, **shares** (buyer received), creator_fee_shares, **cash** (escrowed), cash_paid (left escrow, including anything donated), **price** (raw cash per whole share, floored, saturating), filled_at (chain clock), plan_ref_shares_per_cash_e9? (new reference if a plan was updated) |
| `OrderCancelled` | order, basket, buyer, plan?, by, cash_refunded, expired |
| `PlanOpened` | plan, basket, owner, cash_mint, cash_account, cash_per_run, period_secs, runs, ref_shares_per_cash_e9, band_bps, auction_secs, allowance, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9 |
| `PlanUpdated` | plan, owner, ref_shares_per_cash_e9, band_bps, auction_secs, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9 |
| `PlanRun` | plan, order, run (1-based), cash, start_shares, end_shares, start_ts, end_ts, ref_shares_per_cash_e9, runs_left, next_run_ts |
| `PlanClosed` | plan, owner, runs_done, runs_left, revoked. Emitted by `close_plan` and `close_legacy_plan` |

Events are emitted with `emit!` (program logs). `emit_cpi!` would make them
robust to log truncation and visible to CPI callers, but it adds two accounts
to every instruction, so it is left for a release that can change every
client at once.

---

## 7. Errors

Codes 6000 to 6023 cover baskets, creation and redemption; the codes after them cover orders and plans.

| Code | Name | When |
|---|---|---|
| 6000 | NameTooLong | name empty or > 32 bytes |
| 6001 | SymbolTooLong | symbol empty or > 10 bytes |
| 6002 | CreatorFeeTooHigh | fee > 100 bps |
| 6003 | BadComponentCount | 0 or > 8 components |
| 6004 | WeightsMustSumToOne | weights don't sum to 10,000 |
| 6005 | DuplicateComponent | the same mint appears twice |
| 6006 | ZeroWeight | weight 0 |
| 6007 | ZeroUnits | units_per_share 0 |
| 6008 | ShareMintDecimals | share mint is not 6 decimals |
| 6009 | ShareMintNotEmpty | share mint supply > 0 |
| 6010 | ShareMintAuthority | share mint authority isn't the basket |
| 6011 | ShareMintFreezable | share mint has a freeze authority |
| 6012 | ShareMintMismatch | share mint ≠ basket.share_mint |
| 6013 | WrongTokenProgram | component program mismatch; plan's cash program mismatch |
| 6014 | ComponentMintMismatch | remaining account isn't the recipe's mint |
| 6015 | AccountCountMismatch | remaining accounts ≠ 3 × components |
| 6016 | VaultMismatch | vault isn't the basket PDA's canonical ATA |
| 6017 | TokenAccountMintMismatch | token account for a different mint |
| 6018 | MalformedMint | not a real, initialised mint (e.g. a token account), or malformed extension data |
| 6019 | MalformedTokenAccount | token account data can't be parsed |
| 6020 | MissingCreatorShareAccount | fee shares owed but no creator account |
| 6021 | ZeroShares | zero shares, or nothing left after the fee |
| 6022 | DustMint | a component's deposit would round to 0 |
| 6023 | MathOverflow | checked arithmetic failed |
| 6024 | CreatorShareAccountOwner | the creator fee account isn't owned by the basket creator |
| 6025 | ZeroCash | zero cash, or escrow received nothing |
| 6026 | BadAuctionShares | not `start_shares >= end_shares > 0` |
| 6027 | BadAuctionWindow | not `start_ts < end_ts`, `end_ts > now` and `end_ts <= now + 30 days` |
| 6028 | OrderExpired | fill after `end_ts` |
| 6029 | OrderNotExpired | a non-buyer cancels before `end_ts` has passed |
| 6030 | OrderAccountMismatch | a passed account ≠ the order's basket, buyer, rent payer or cash mint |
| 6031 | MissingPlanAccount | plan order filled without its plan account |
| 6032 | PlanMismatch | plan account ≠ `order.plan` |
| 6033 | PlanAccountMismatch | wrong owner, cash mint or cash account for the plan |
| 6034 | BadPlanSchedule | period or runs is zero or negative, or the auction length isn't within 1 s to 30 days |
| 6035 | BadReferenceRate | reference rate 0 |
| 6036 | BandTooWide | band > 5000 bps |
| 6037 | PlanAmountTooSmall | a run's `end_shares` would be 0 |
| 6038 | PlanTooEarly | `now < next_run_ts` |
| 6039 | PlanExhausted | `runs_left == 0` |
| 6040 | DelegateInUse | the cash account already delegates a live allowance elsewhere |
| 6041 | ShareMintProgram | share mint isn't owned by SPL Token or Token-2022 |
| 6042 | ShareMintExtension | share mint carries an extension other than metadata |
| 6043 | ComponentMintExtension | component carries an extension that could drain, pause or brick the vault |
| 6044 | CashMintExtension | cash mint carries an extension that could seize, freeze or block escrowed cash |
| 6045 | EscrowShort | escrow holds less than `order.cash_amount` at fill time |
| 6046 | BadReferenceBounds | not `0 < min <= ref <= max` |
| 6047 | NotLegacyPlan | `close_legacy_plan` on something that isn't a 280-byte first-release plan |
| 6048 | ComponentIssuerAuthority | a component's freeze authority, permanent delegate, pause, confidential-transfer or program-less hook authority is held by someone outside `KNOWN_ISSUERS` |
| 6049 | CashMintAuthority | a cash mint's transfer-fee config authority, or the authority of its program-less transfer hook, is held by someone outside `KNOWN_ISSUERS` |
| 6050 | ShareMintNotToken2022 | share mint is a legacy SPL Token mint |

Anchor's own constraint errors also apply: `ConstraintTokenOwner` (a refund to a
non-buyer account), `ConstraintAssociated` (shares to a non-canonical account),
`AccountNotInitialized` (running a closed plan) and `AccountDidNotDeserialize`
(a current-layout instruction on a first-release plan).

---

## 8. Security reasoning: who can move what

**Component vaults** (basket PDA's ATAs). Value enters only through
`deposit_components` (from `mint_shares` or `fill_order`), always rounded up
and grossed up for transfer fees. It leaves only through `redeem_shares`, and
only after the redeemer's shares are burned, rounded down. Neither the desk
nor plans can withdraw from a vault, so a fill can only ever **add** backing.
A vault is accepted only at its canonical ATA address, so a deposit can't be
diverted to an impostor account.

**Share mint** (authority: basket PDA). It carries metadata and nothing else,
checked at creation and again at every issuance, so no permanent delegate,
pause switch, hook, close authority or display multiplier can sit over
holders' shares. Shares are minted only against a
completed in-kind deposit: in `mint_shares`, and in `fill_order` after
`deposit_components` succeeds in the same instruction. Fee shares go only to
an account **owned by the basket creator**, not merely one of the right
mint, so a depositor cannot pass their own share account and take the fee
back.

**Cash mint policy** (`place_order`, `open_plan`). Refused:

- `PermanentDelegate`, which could pull the escrow back out after the filler
  has priced off `order.cash_amount`, so the filler delivers stocks for nothing.
- `Pausable`.
- A frozen `DefaultAccountState`.
- `NonTransferable`.
- A `TransferHook` with a program set, whose accounts aren't forwarded.
- Any extension number the program doesn't know.

Accepted only when the authority is empty or in `KNOWN_ISSUERS`
(`CashMintAuthority`), because that authority could change it after an
order is placed:

- `TransferFeeConfig`: its config authority could raise the fee to 100% and
  take the filler's payout. (The devnet test dollar has no transfer fee.)
- A `TransferHook` with no program set: its authority could set one.

Metadata, confidential-transfer configs, interest or scaled display, and a
close authority (a mint can't close while escrow holds supply) can't touch
an escrow and are allowed. A plain freeze authority (USDC
has one) is the issuer's power over every holder and is accepted as a stated
trust assumption. `fill_order` independently requires
`escrow.amount >= order.cash_amount`.

**Order escrow** (authority: order PDA). It moves only by the order PDA's
signature, in exactly two ways:

- `fill_order`, to the filler, and only after the buyer's shares have been
  minted in the same instruction. A partial fill can't happen: if any
  deposit, mint or transfer fails, the whole transaction reverts.
- `cancel_order`, back to an account the buyer owns (`token::authority = buyer`).
  A stranger who cancels an expired order can't redirect the refund; the
  test suite checks this.

**Where the buyer's shares land**: only the buyer's canonical share ATA, pinned
by an associated-token constraint. The filler can't redirect them (tested).

**What the buyer gets**: the share count is a pure function of the order's
immutable fields and the chain clock. The filler chooses only *when* to fill,
never *how much*. After `end_ts` the order can't be filled at all, so a stale
order is never a free option for a filler.

**Rent**: it always returns to whoever paid it (`order.rent_payer`), so a
cranker who fronts a plan order's rent is made whole when the order closes.

**Plan allowance**: the plan PDA is the SPL delegate for at most
`cash_per_run × runs`, and the token program enforces and decrements it.
`run_plan` is permissionless, but it can only move `cash_per_run`, only from
`plan.cash_account`, only into a fresh order escrow whose buyer is the plan
owner, and only when the schedule allows. A cranker can choose *when* (after
`next_run_ts`) and the nonce, nothing else. The owner can cancel any plan
order at any time, and `close_plan` revokes what's left of the allowance.

**Reference rate**: it changes only on a fill of one of the plan's own orders.
The plan account is pinned by the order, so a filler can't skip the update.
It is computed from `order.cash_amount` (recorded at placement), **not** the
live escrow balance. Otherwise someone could donate to an escrow, fill the
order themselves, and push the rate wherever they wanted. Each fill lands
inside `[end, start]`, which lies within `ref × (1 ± band)`, so one fill
moves the reference by at most `band`. On top of that, every recorded rate
is clamped to the owner's `[min, max]`, and no auction ends below `min`, so
no sequence of fills can walk a plan past the owner's limits. A stale order
from a previous incarnation of the same plan id is ignored. The owner can
re-centre at any time with `update_plan`.

**Arithmetic**: all of it is checked or widened (u128/i128). Overflow fails
the instruction. Values that exist only for the event log (`price`) saturate,
and a plan rate that can't be represented is skipped, so neither can make a
valid fill fail.

### Trust assumptions and known limits

- **Thin fill competition.** The auction assumes competing fillers. A filler
  with no competition can wait until `end_ts` every run, so each run fills at
  the bottom of its auction. Since this release, that bottom is never below
  the owner's `min_ref`: the worst case is the owner's own limit price, not a
  geometric ratchet. The owner can also re-centre with `update_plan`.
- **Issuer powers are a named trust assumption.** Every real xStock and
  PreStock lets its issuer freeze, seize (permanent delegate) or pause the
  token, and so the share of a basket's vault held in it, as with any
  tokenized stock. Sheaf accepts those powers only from the issuers
  themselves (`KNOWN_ISSUERS`): a basket holder trusts each stock's issuer
  and nobody else. A basket creator cannot add such a power, because a
  component whose freeze, delegate, pause, confidential-transfer or hook
  authority is anyone else is refused at creation and at every deposit. An
  issuer that pauses or freezes one component blocks redemption of the
  whole basket until it lifts it, since a redemption pays out every
  component in one transaction. Adding a new issuer is a program upgrade.
- **Cash issuers.** A cash mint's plain freeze authority (USDC has one) can
  still freeze an escrow, as it can for any holder. Cash with a permanent
  delegate or a pause switch is refused whoever holds it, so PYUSD (which has
  a permanent delegate) isn't accepted as cash. All six live devnet baskets,
  their 15 component mints and the devnet cash mint were audited against the
  policy before the upgrade: none has a freeze authority, and the mirrors'
  only authority-bearing extensions (metadata, ScaledUiAmount, transfer fee)
  are not gated.
- **Creator-fee rounding.** The fee is floored, so a mint of fewer than
  `10_000 / fee_bps` raw units (333 at 30 bps) pays no fee. Each such
  instruction saves less than one raw share unit, about $0.00025 at $250 a
  share, which is less than the transaction fee it costs. Rounding up would
  forbid the 1-unit mints the backing property test relies on. Left as is.
- **SBPF version.** The program is built as SBPFv0. Devnet still accepts v0
  deployments, but SIMD-0500 (already active on recent local validators)
  disables them. Once that reaches devnet or mainnet, a further upgrade must
  be rebuilt for a newer SBPF target.
- **One delegate per token account.** A cash account can back only one active
  plan at a time. `open_plan` refuses (`DelegateInUse`) rather than silently
  breaking an existing allowance. Use a separate cash account per plan.
- **Predictable escrow address.** The escrow is `init_if_needed` and measured
  by balance delta, so someone creating the ATA first can't block an order.
  User orders and plan orders have separate PDA namespaces, so a cranker can't
  squat a nonce the owner is about to use. Within a namespace, a collision
  just means choosing another nonce.
- **Transaction size.** `fill_order` takes 15 named accounts plus 3 per
  component. Baskets of more than about 5 components need an address lookup
  table to fit in one transaction.
- **Clock.** Auctions use `Clock::unix_timestamp`, which is the cluster's
  stake-weighted time and can drift by a few seconds. Windows should be minutes.
- **Compute.** A 3-component fill with a creator fee uses roughly 55k to 70k CU
  (measured in tests; the variation comes from PDA bump searches, and the
  extension re-checks add a few thousand). The tests still request 400k.

---

## 9. Tests

`anchor test` runs 59 integration tests: 7 against real mainnet mints
(`tests/mainnet-clone.ts`), 11 basket tests, 28 desk and plan tests, and 13
hardening tests. `cargo test -p sheaf --lib` runs 10 unit tests: the auction
line, the gross-up, the plan bounds and floor, the three extension policies
(built from synthetic TLV images: every issuer power under nobody, under each
known issuer and under a stranger, a freeze authority, malformed lengths and
unknown types), the transfer-fee schedule read by number, the issuer keys
themselves, and the size of the plan layout.

**Against real mints.** `tests/fixtures/build.mjs` reads TSLAx
(`XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`), NVDAx
(`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`) and PreStocks Anduril
(`PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB`) from mainnet and writes each
as a `[[test.validator.account]]` fixture, byte for byte, except that the
mint authority is rewritten to a throwaway localnet key so the test can mint
balances (a plain `--clone` gives the mint but no way to hold any). Every
extension and every issuer authority is left as the issuer set it. The test
checks the clones still carry the permanent delegate, pause switch, freeze
authority, confidential-transfer configs, program-less hook, default state,
ScaledUiAmount, metadata and (Anduril) the transfer fee and its confidential
config, under Backed's and PreStocks' keys; then creates a basket of the
three, mints two shares (the vault nets exactly the recipe, with Anduril's
live 3% fee grossed up), redeems one, refuses a look-alike mint whose powers
belong to the creator, and drives the two fixture-only paths: `EscrowShort`
on an order whose escrow holds less than it records, and `close_legacy_plan`
on a 280-byte first-release plan (allowance revoked, rent returned).

The rest of the integration suite covers:

- Placing an order: escrow and order fields, and the malformed auction cases
  (rising, zero floor, closed window, zero-length window, zero cash).
- Filling **before start** (exactly `start_shares`), **mid-auction** (the
  exact line at the event's on-chain timestamp, strictly inside the band) and
  **at `end_ts`** (exactly `end_shares`; the test aims at the closing second
  and retries if it lands late). Each fill checks the exact per-vault deposit,
  the buyer's and creator's share deltas, the filler's cash, that both
  accounts are closed, and that the rent was refunded.
- Rejection paths: filling after expiry; a short deposit; an impostor vault;
  a missing component; shares redirected to the filler. The order and its
  cash are checked intact afterwards.
- Cancels: the buyer at any time; a stranger before expiry (fails); a stranger
  after expiry (succeeds, and a refund to the stranger's account fails).
- A creator fee sent to a non-creator account (`CreatorShareAccountOwner`).
- Token-2022 cash with a transfer fee: escrow records the net received, the
  filler nets escrow minus the outgoing fee, and the escrow closes after the
  withheld fee is harvested.
- Plans: parameter validation; open and delegate in one instruction (the
  delegated amount is exactly `cash × runs`); `DelegateInUse`; run 1 and its
  bounds; a run too early; a fill without, or with the wrong, plan account; a
  fill that updates the reference to `floor(shares × 10^9 / cash)` and refunds
  the cranker's rent; run 2 after the period from the new reference, which
  spends the allowance so the token program clears the delegate; a run on an
  exhausted plan; close by a stranger (fails) and by the owner; a fill of an
  order left by a closed plan; and Token-2022 cash with a fee, where closing
  revokes the remaining allowance, a run after close fails, and an open order
  is cancelled.
- Hardening:
  - A share mint with each of PermanentDelegate, Pausable,
    MintCloseAuthority, TransferHook, ScaledUiAmount and NonTransferable is
    refused. A token account or a system account posing as the share mint is
    refused, and so is a legacy SPL Token share mint.
  - Components that are frozen-by-default, have a hook program,
    NonTransferable or MintCloseAuthority are refused; so are a permanent
    delegate, a pause switch, a program-less hook and a freeze authority held
    by the creator, and a token account posing as a mint. A component
    carrying all the issuer powers under the stand-in issuer, a ScaledUiAmount
    component and a metadata component are accepted together.
  - Cash with PermanentDelegate, Pausable, frozen-by-default or a live
    TransferHook is refused at `place_order`, and the first three at `open_plan`.
  - Cash whose transfer-fee authority or program-less hook authority is the
    buyer is refused at `place_order` and `open_plan`; the same cash with no
    such authority, or the stand-in issuer's, is accepted.
  - An order and a plan auction closing more than 30 days out are refused.
  - `0 < min <= ref <= max` is enforced.
  - A run's auction ends exactly at the owner's floor (360,000, not the
    band's 280,000), and a richer fill is clamped to the ceiling.
  - `update_plan`: a stranger is refused, as are bad bounds and a bad band.
    The owner's update is stored, and the next run uses it exactly
    (550,000 to 450,000 over 60 s).
  - The same nonce is used for a plan order and a user order, side by side.
  - An order from a closed plan doesn't touch the plan reopened under the
    same id.
  - `close_legacy_plan` refuses a current-layout plan.

`EscrowShort` can't be reached through the program any more: the cash
policy refuses every mint that could drain an escrow. It protects orders
placed before the policy existed, and is tested with a fixture order (see
"Against real mints").
