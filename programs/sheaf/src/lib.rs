//! Sheaf — permissionless, in-kind index baskets for tokenized equities, with
//! an oracle-free cash desk on top.
//!
//! A basket is a fixed recipe: for one whole share, hand the vault
//! `units_per_share` raw units of each component and receive one share token.
//! Burn a share token and the vault hands the components back, pro rata.
//!
//! Everything is settled in kind. The program never reads a price feed, so a
//! stale or manipulated oracle cannot mis-price a mint or a redemption, and the
//! vault cannot become under-collateralised: minting rounds deposits up and
//! redeeming rounds withdrawals down, so rounding dust always favours the vault.
//!
//! Components are Token-2022 mints (every xStock is). The `ScaledUiAmount`
//! extension that xStocks use to accrue dividends multiplies the *displayed*
//! balance, never the raw balance, so a raw-unit recipe is unaffected by it and
//! dividend accrual flows through to holders automatically.
//!
//! Every real xStock and PreStock also carries its issuer's powers: a freeze
//! authority, a permanent delegate, a pause switch, confidential-transfer
//! configs and a program-less transfer hook. Holding a tokenized stock means
//! trusting its issuer with those, so a component may carry them only when
//! every authority on them is empty or one of `KNOWN_ISSUERS` (the issuers'
//! own mainnet keys). Nobody else, the basket creator included, can bring such
//! a lever into a basket.
//!
//! Some components (PreStocks pre-IPO tokens) also carry `TransferFeeConfig`,
//! which skims a fee out of every transfer at the token-program level. A
//! deposit grosses up for that fee so the vault still receives exactly the
//! recipe amount; a redemption pays the fee out of what leaves the vault,
//! same as any other holder of that token would.
//!
//! ## The cash desk
//!
//! Most people hold cash, not eight tokenized equities. The desk lets a buyer
//! escrow cash and post a Dutch auction for shares: the number of shares the
//! buyer must receive starts high and decays linearly to the buyer's floor.
//! Anyone may fill at any moment by delivering the components for those shares
//! in kind (through exactly the same deposit path as `mint_shares`) and taking
//! the escrowed cash. The first filler for whom the deal is worth it wins, so
//! price discovery happens between fillers, and the program still never reads
//! a price.
//!
//! ## Plans
//!
//! A plan is a recurring buy. The owner delegates a capped cash allowance to
//! the plan PDA once; a permissionless crank turns one slice of it into a desk
//! order each period, bracketing a reference rate by a band. Every time a plan
//! order fills, the reference rate moves to the rate it filled at, so the plan
//! follows the market with no oracle.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, ApproveChecked, Burn, CloseAccount, Mint, MintTo, Revoke, TokenAccount,
    TokenInterface, TransferChecked,
};
use spl_token_2022::extension::{
    transfer_fee::{TransferFee, TransferFeeAmount},
    BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022::state::{Account as SplAccount, Mint as SplMint};

declare_id!("GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Sheaf",
    project_url: "https://github.com/RohanGlitched/sheaf",
    contacts: "link:https://github.com/RohanGlitched/sheaf/issues",
    policy: "https://github.com/RohanGlitched/sheaf/issues",
    preferred_languages: "en",
    source_code: "https://github.com/RohanGlitched/sheaf",
    source_release: "",
    auditors: "None"
}

/// Share tokens always have 6 decimals.
pub const SHARE_DECIMALS: u8 = 6;
/// One whole share, in raw share units.
pub const ONE_SHARE: u64 = 1_000_000;
/// Upper bound on basket size, so `mint`/`redeem` fit in one transaction.
pub const MAX_COMPONENTS: usize = 8;
/// Creator fees are capped at 1%.
pub const MAX_CREATOR_FEE_BPS: u16 = 100;
/// The protocol's creation fee: 0.10% of the shares a deposit creates, written
/// into every basket at `create_basket` and never changeable afterwards.
/// Redemption is free. Baskets created before this fee existed carry 0.
pub const PROTOCOL_FEE_BPS: u16 = 10;
/// Where claimed protocol fees go: the treasury's Token-2022 share account
/// (its associated token account for the basket's share mint).
pub const TREASURY: Pubkey =
    anchor_lang::solana_program::pubkey!("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
/// Basis-point denominator.
pub const BPS: u64 = 10_000;
/// Fixed-point scale of a plan's reference rate: raw share units per raw cash
/// unit, times 10^9.
pub const RATE_SCALE: u64 = 1_000_000_000;
/// A plan's auction band is capped at ±50% of its reference rate.
pub const MAX_BAND_BPS: u16 = 5_000;
/// No order (or plan auction) may close more than 30 days out.
pub const MAX_ORDER_SECS: i64 = 30 * 24 * 60 * 60;
/// The trailing step clients are expected to offer (the owner picks it at
/// `open_plan`; 0 means fixed bounds). With step `s`, after every fill the
/// plan's working bounds become `ref × (1 ± s)`, intersected with the owner's
/// hard limits, so the plan follows the market inside the owner's limits and
/// no single run moves its reference more than `s`.
pub const PLAN_STEP_BPS: u16 = 600;
/// The largest trailing step `open_plan` accepts.
pub const MAX_TRAIL_STEP_BPS: u16 = 5_000;
/// Bytes after a `Plan`'s serialized fields: `trail_step_bps: u16`, 6
/// reserved, then the owner's hard limits `hard_min_e9: u64` and
/// `hard_max_e9: u64`, which only `update_plan` changes. Plans opened before
/// trailing bounds have no tail (fixed bounds); plans opened in the first
/// trailing release have only the 8-byte step part (no hard limits).
pub const PLAN_TAIL_LEN: usize = 24;
/// An order or sell order may not start more than this long before it lands,
/// so a slow wallet or a slow clock cannot hand a filler most of the decay.
pub const MAX_START_LAG_SECS: i64 = 60;
/// The SPL Memo program, CPI'd before a transfer into an account that
/// requires incoming memos (Token-2022 MemoTransfer).
pub const MEMO_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// Backed Finance (xStocks): permanent delegate, confidential-transfer,
/// transfer-hook and metadata authority on every xStock mint.
pub const BACKED_ISSUER: Pubkey =
    anchor_lang::solana_program::pubkey!("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq");
/// Backed Finance (xStocks): pause and freeze authority on every xStock mint.
pub const BACKED_PAUSER: Pubkey =
    anchor_lang::solana_program::pubkey!("JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs");
/// PreStocks: every authority (delegate, pause, freeze, fees, hook) on every
/// PreStocks mint.
pub const PRESTOCKS_ISSUER: Pubkey =
    anchor_lang::solana_program::pubkey!("WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
/// The write cluster's stand-in issuer: the key that mints the devnet mirrors
/// of xStocks and PreStocks and the test dollar. Known only in a `devnet`
/// build.
pub const STAND_IN_ISSUER: Pubkey =
    anchor_lang::solana_program::pubkey!("B8dLfY9rokrZwq7ae1CuVfi8deSoeywgJGiS3W2U9U1L");
/// The write cluster's deploy key, which set up the PreStocks mirrors and holds
/// their transfer-fee authority. It is also the devnet program's upgrade
/// authority, so trusting it as an issuer there adds no power it lacks. Known
/// only in a `devnet` build.
pub const STAND_IN_FEE_AUTHORITY: Pubkey =
    anchor_lang::solana_program::pubkey!("7md5ecBazJtGoHEkRvQaVSdNz7pyJrbmrHgx1L5NVJb4");

/// Issuers of tokenized stocks whose powers a component may carry.
///
/// Every real xStock and PreStock carries issuer powers: a permanent
/// delegate, a pause switch, a freeze authority, confidential-transfer and
/// transfer-hook authorities. The issuer can freeze, seize or pause its own
/// token, as with any tokenized security, and that is a named trust
/// assumption of holding one. A component may carry those powers only when
/// every authority on them is empty or one of these keys, so a basket's
/// holders trust each stock's issuer and nobody else: a basket creator cannot
/// slip in a token that gives *them* such a lever. The keys were read off the
/// live mainnet mints (see docs/program.md).
///
/// The default build knows only the real issuers. The write cluster's
/// stand-in keys are added by the `devnet` feature alone, so forgetting a flag
/// can never produce a mainnet program that trusts a server key as an issuer.
/// The list is compile-time: an issuer rotating a key stops new deposits into
/// affected baskets until an upgrade (redemptions never re-check it).
#[cfg(not(feature = "devnet"))]
pub const KNOWN_ISSUERS: [Pubkey; 3] = [BACKED_ISSUER, BACKED_PAUSER, PRESTOCKS_ISSUER];
#[cfg(feature = "devnet")]
pub const KNOWN_ISSUERS: [Pubkey; 5] = [
    BACKED_ISSUER,
    BACKED_PAUSER,
    PRESTOCKS_ISSUER,
    STAND_IN_ISSUER,
    STAND_IN_FEE_AUTHORITY,
];

/// Whether `key` is in `KNOWN_ISSUERS`.
pub fn is_known_issuer(key: &Pubkey) -> bool {
    KNOWN_ISSUERS.contains(key)
}

#[program]
pub mod sheaf {
    use super::*;

    /// Publish a basket recipe and take ownership of its share mint.
    ///
    /// The share mint is created by the client (a Token-2022 mint carrying
    /// on-chain metadata) with its mint authority already set to this basket's
    /// PDA. We verify that here rather than trusting it.
    pub fn create_basket(
        ctx: Context<CreateBasket>,
        name: String,
        symbol: String,
        creator_fee_bps: u16,
        components: Vec<ComponentArg>,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, SheafError::NameTooLong);
        require!(
            !symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN,
            SheafError::SymbolTooLong
        );
        require!(
            creator_fee_bps <= MAX_CREATOR_FEE_BPS,
            SheafError::CreatorFeeTooHigh
        );
        require!(
            !components.is_empty() && components.len() <= MAX_COMPONENTS,
            SheafError::BadComponentCount
        );

        let basket_key = ctx.accounts.basket.key();
        let token_program_key = ctx.accounts.component_token_program.key();

        // The share mint must be a blank, basket-controlled, 6-decimal
        // Token-2022 mint, carrying nothing but metadata. Any other
        // extension (a permanent delegate, a pause switch, a transfer hook, a
        // close authority, a display multiplier...) would leave the creator a
        // lever over holders' shares, so it is refused outright.
        let share_mint_info = ctx.accounts.share_mint.to_account_info();
        require!(
            is_token_program(share_mint_info.owner),
            SheafError::ShareMintProgram
        );
        // Shares are always Token-2022 (they carry on-chain metadata, and every
        // client derives share accounts under Token-2022).
        require!(
            share_mint_info.owner == &spl_token_2022::ID,
            SheafError::ShareMintNotToken2022
        );
        let mint_state = load_mint(&share_mint_info)?;
        check_share_mint_extensions(&share_mint_info.try_borrow_data()?)?;
        require!(
            mint_state.decimals == SHARE_DECIMALS,
            SheafError::ShareMintDecimals
        );
        require!(mint_state.supply == 0, SheafError::ShareMintNotEmpty);
        let mint_authority: Option<Pubkey> = mint_state.mint_authority.into();
        require!(
            mint_authority == Some(basket_key),
            SheafError::ShareMintAuthority
        );
        require!(
            mint_state.freeze_authority.is_none(),
            SheafError::ShareMintFreezable
        );

        // Components must be distinct, correctly weighted, and live on the
        // token program the caller declared.
        let mut total_weight: u32 = 0;
        let mut stored: [Component; MAX_COMPONENTS] = Default::default();

        require!(
            ctx.remaining_accounts.len() == components.len(),
            SheafError::AccountCountMismatch
        );

        for (i, arg) in components.iter().enumerate() {
            require!(arg.units_per_share > 0, SheafError::ZeroUnits);
            require!(arg.weight_bps > 0, SheafError::ZeroWeight);
            for prior in components.iter().take(i) {
                require!(prior.mint != arg.mint, SheafError::DuplicateComponent);
            }
            total_weight = total_weight
                .checked_add(arg.weight_bps as u32)
                .ok_or(SheafError::MathOverflow)?;

            let mint_info = &ctx.remaining_accounts[i];
            require!(mint_info.key() == arg.mint, SheafError::ComponentMintMismatch);
            require!(
                mint_info.owner == &token_program_key && is_token_program(&token_program_key),
                SheafError::WrongTokenProgram
            );
            // A real, initialised mint (not, say, a token account that happens
            // to be 82+ bytes), whose powers over the vault (freeze, seize,
            // pause, hook) are empty or held by a known stock issuer.
            let decimals = load_mint(mint_info)?.decimals;
            check_component_extensions(&mint_info.try_borrow_data()?)?;

            stored[i] = Component {
                mint: arg.mint,
                units_per_share: arg.units_per_share,
                weight_bps: arg.weight_bps,
                decimals,
                _padding: [0; 5],
            };
        }
        require!(total_weight == 10_000, SheafError::WeightsMustSumToOne);

        let basket = &mut ctx.accounts.basket;
        basket.creator = ctx.accounts.creator.key();
        basket.share_mint = ctx.accounts.share_mint.key();
        basket.token_program = token_program_key;
        basket.name = name.clone();
        basket.symbol = symbol.clone();
        basket.creator_fee_bps = creator_fee_bps;
        basket.component_count = components.len() as u8;
        basket.components = stored;
        basket.created_at = Clock::get()?.unix_timestamp;
        basket.mint_count = 0;
        basket.redeem_count = 0;
        basket.bump = ctx.bumps.basket;
        basket.protocol_fee_bps = PROTOCOL_FEE_BPS;
        basket.protocol_fee_accrued = 0;

        emit!(BasketCreated {
            basket: basket_key,
            creator: basket.creator,
            share_mint: basket.share_mint,
            name,
            symbol,
            component_count: basket.component_count,
        });
        emit!(BasketFeeTerms {
            basket: basket_key,
            creator_fee_bps,
            protocol_fee_bps: PROTOCOL_FEE_BPS,
            treasury: TREASURY,
        });
        Ok(())
    }

    /// Deposit the recipe in kind and receive `shares` share tokens.
    ///
    /// `remaining_accounts` is three per component, in basket order:
    /// `[component_mint, depositor_token_account, basket_vault_ata]`.
    pub fn mint_shares<'info>(
        ctx: Context<'_, '_, 'info, 'info, MintShares<'info>>,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, SheafError::ZeroShares);
        let basket = &ctx.accounts.basket;
        let basket_key = basket.key();

        let deposited = deposit_components(
            basket,
            &basket_key,
            ctx.remaining_accounts,
            &ctx.accounts.component_token_program.to_account_info(),
            &ctx.accounts.depositor.to_account_info(),
            shares,
        )?;

        // The creator's and the protocol's cuts come out of the shares
        // created, never out of the vault, so backing per share is identical
        // before and after. The protocol's cut is accrued, backed by this very
        // deposit, and minted to the treasury by `claim_protocol_fee`.
        let (fee_shares, protocol_shares) =
            fee_split(shares, basket.creator_fee_bps, basket.protocol_fee_bps)?;
        let net_shares = shares
            .checked_sub(fee_shares)
            .and_then(|n| n.checked_sub(protocol_shares))
            .ok_or(SheafError::MathOverflow)?;
        require!(net_shares > 0, SheafError::ZeroShares);

        issue_shares(
            basket,
            ctx.accounts.basket.to_account_info(),
            ctx.accounts.share_mint.to_account_info(),
            ctx.accounts.share_token_program.to_account_info(),
            ctx.accounts.depositor_share_account.to_account_info(),
            ctx.accounts
                .creator_share_account
                .as_ref()
                .map(|a| a.to_account_info()),
            net_shares,
            fee_shares,
        )?;

        let basket = &mut ctx.accounts.basket;
        basket.mint_count = basket.mint_count.saturating_add(1);
        accrue_protocol_fee(basket, basket_key, protocol_shares)?;

        emit!(SharesMinted {
            basket: basket_key,
            depositor: ctx.accounts.depositor.key(),
            shares_issued: net_shares,
            creator_fee_shares: fee_shares,
            amounts: deposited,
        });
        Ok(())
    }

    /// Burn `shares` and take the underlying components back out, pro rata.
    ///
    /// `remaining_accounts` is three per component, in basket order:
    /// `[component_mint, basket_vault_ata, recipient_token_account]`.
    pub fn redeem_shares<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemShares<'info>>,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, SheafError::ZeroShares);
        let basket = &ctx.accounts.basket;
        let count = basket.component_count as usize;
        require!(
            ctx.remaining_accounts.len() == count * 3,
            SheafError::AccountCountMismatch
        );
        require!(
            ctx.accounts.component_token_program.key() == basket.token_program,
            SheafError::WrongTokenProgram
        );

        let basket_key = basket.key();
        let token_program_key = basket.token_program;

        // Burn first: no component leaves the vault until the shares are gone.
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.share_token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.owner_share_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            shares,
        )?;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"basket",
            basket.creator.as_ref(),
            basket.symbol.as_bytes(),
            &[basket.bump],
        ]];

        let mut withdrawn = [0u64; MAX_COMPONENTS];

        for i in 0..count {
            let component = basket.components[i];
            let mint_info = &ctx.remaining_accounts[i * 3];
            let vault_info = &ctx.remaining_accounts[i * 3 + 1];
            let to_info = &ctx.remaining_accounts[i * 3 + 2];

            require!(
                mint_info.key() == component.mint,
                SheafError::ComponentMintMismatch
            );
            verify_vault(vault_info, &basket_key, &component.mint, &token_program_key)?;
            verify_token_account(to_info, &component.mint)?;

            // Withdrawals round down, so rounding dust stays in the vault.
            let amount = mul_div_floor(component.units_per_share, shares, ONE_SHARE)?;
            if amount == 0 {
                continue;
            }

            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.component_token_program.to_account_info(),
                    TransferChecked {
                        from: vault_info.clone(),
                        mint: mint_info.clone(),
                        to: to_info.clone(),
                        authority: ctx.accounts.basket.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
                component.decimals,
            )?;
            withdrawn[i] = amount;
        }

        let basket = &mut ctx.accounts.basket;
        basket.redeem_count = basket.redeem_count.saturating_add(1);

        emit!(SharesRedeemed {
            basket: basket_key,
            owner: ctx.accounts.owner.key(),
            shares_burned: shares,
            amounts: withdrawn,
        });
        Ok(())
    }

    // ------------------------------------------------------------ cash desk

    /// Escrow `cash_amount` of a cash mint and post a Dutch auction for shares.
    ///
    /// The number of shares the buyer must *receive* (net of the creator fee)
    /// is `start_shares` until `start_ts`, decays linearly to `end_shares` at
    /// `end_ts`, and the order cannot be filled after `end_ts`.
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        nonce: u64,
        cash_amount: u64,
        start_shares: u64,
        end_shares: u64,
        start_ts: i64,
        end_ts: i64,
    ) -> Result<()> {
        require!(cash_amount > 0, SheafError::ZeroCash);
        let now = Clock::get()?.unix_timestamp;
        validate_auction(start_shares, end_shares, start_ts, end_ts, now)?;
        require_fresh_start(start_ts, now)?;
        // No cash a third party (or the buyer) could pull back out of escrow,
        // freeze in place, or make untransferable before a filler is paid.
        check_cash_mint_extensions(&ctx.accounts.cash_mint.to_account_info().try_borrow_data()?)?;

        let escrowed = fund_escrow(
            ctx.accounts.buyer_cash_account.to_account_info(),
            &ctx.accounts.cash_mint,
            &mut ctx.accounts.escrow,
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            cash_amount,
            &[],
        )?;

        let order_key = ctx.accounts.order.key();
        let order = &mut ctx.accounts.order;
        order.basket = ctx.accounts.basket.key();
        order.buyer = ctx.accounts.buyer.key();
        order.rent_payer = ctx.accounts.buyer.key();
        order.cash_mint = ctx.accounts.cash_mint.key();
        order.cash_token_program = ctx.accounts.cash_token_program.key();
        order.plan = None;
        order.nonce = nonce;
        order.cash_amount = escrowed;
        order.start_shares = start_shares;
        order.end_shares = end_shares;
        order.start_ts = start_ts;
        order.end_ts = end_ts;
        order.created_at = now;
        order.bump = ctx.bumps.order;

        emit_order_placed(order, order_key);
        Ok(())
    }

    /// Fill an open order: deliver the components, the buyer gets the shares,
    /// the filler gets the cash. Permissionless.
    ///
    /// The auction's current share count is what the buyer *receives*. The
    /// filler delivers components for `gross` shares, the smallest count whose
    /// creator fee (computed exactly as in `mint_shares`) leaves that much for
    /// the buyer, and the creator receives `gross - received`.
    ///
    /// `remaining_accounts` is the same as `mint_shares`, with the filler's
    /// component accounts as the source.
    pub fn fill_order<'info>(ctx: Context<'_, '_, 'info, 'info, FillOrder<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let order_key = ctx.accounts.order.key();
        let order: Order = (**ctx.accounts.order).clone();
        require!(now <= order.end_ts, SheafError::OrderExpired);
        // The filler is about to deliver stocks against `cash_amount`; make
        // sure that cash is really still there (a seize power on the cash mint,
        // on an order placed before mints like that were refused, could have
        // emptied it).
        require!(
            ctx.accounts.escrow.amount >= order.cash_amount,
            SheafError::EscrowShort
        );

        let shares_out = required_shares(
            order.start_shares,
            order.end_shares,
            order.start_ts,
            order.end_ts,
            now,
        )?;

        let basket = &ctx.accounts.basket;
        let basket_key = basket.key();
        let gross = gross_shares_for_net(shares_out, total_fee_bps(basket))?;
        let (fee_shares, protocol_shares) =
            fee_split(gross, basket.creator_fee_bps, basket.protocol_fee_bps)?;
        require!(
            gross.checked_sub(fee_shares).and_then(|n| n.checked_sub(protocol_shares))
                == Some(shares_out),
            SheafError::MathOverflow
        );

        // Same deposit path, rounding and vault checks as `mint_shares`. One
        // extra trailing account is allowed: the Memo program, for a filler
        // whose cash account requires incoming memos.
        let triples = basket.component_count as usize * 3;
        let remaining = ctx.remaining_accounts;
        require!(
            remaining.len() == triples
                || (remaining.len() == triples + 1 && remaining[triples].key == &MEMO_PROGRAM_ID),
            SheafError::AccountCountMismatch
        );
        let deposited = deposit_components(
            basket,
            &basket_key,
            &remaining[..triples],
            &ctx.accounts.component_token_program.to_account_info(),
            &ctx.accounts.filler.to_account_info(),
            gross,
        )?;

        issue_shares(
            basket,
            ctx.accounts.basket.to_account_info(),
            ctx.accounts.share_mint.to_account_info(),
            ctx.accounts.share_token_program.to_account_info(),
            ctx.accounts.buyer_share_account.to_account_info(),
            ctx.accounts
                .creator_share_account
                .as_ref()
                .map(|a| a.to_account_info()),
            shares_out,
            fee_shares,
        )?;

        // Only then does the cash leave escrow.
        let paid = drain_and_close_escrow(
            &order,
            order_key,
            ctx.accounts.order.to_account_info(),
            &ctx.accounts.escrow,
            ctx.accounts.cash_mint.to_account_info(),
            ctx.accounts.cash_mint.decimals,
            ctx.accounts.filler_cash_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            remaining,
        )?;

        // A plan's reference rate follows the rate its last order filled at.
        // The plan key is pinned by the order, so a filler cannot skip this.
        let mut new_plan_rate: Option<u64> = None;
        if let Some(plan_key) = order.plan {
            let plan_info = ctx
                .accounts
                .plan
                .as_ref()
                .ok_or(SheafError::MissingPlanAccount)?
                .to_account_info();
            require!(plan_info.key() == plan_key, SheafError::PlanMismatch);
            // A plan that has since been closed, or that still has the
            // pre-hardening layout, is simply not updated: the buyer's fill
            // must never depend on it.
            let (decoded, step, hard) = if plan_info.owner == &crate::ID && plan_info.lamports() > 0 {
                let data = plan_info.try_borrow_data()?;
                (Plan::try_deserialize(&mut &data[..]).ok(), plan_trail_step(&data), plan_hard_limits(&data))
            } else {
                (None, 0, None)
            };
            if let Some(mut plan) = decoded {
                // Same plan, and the same incarnation of it: an order left
                // over from before the plan was closed and reopened under the
                // same id must not steer the new plan.
                if plan.basket == order.basket
                    && plan.owner == order.buyer
                    && plan.cash_mint == order.cash_mint
                    && order.created_at >= plan.created_at
                {
                    // A rate that does not fit (or rounds to zero) is not
                    // recorded, and a recorded rate stays inside the plan's
                    // bounds. Fixed-bound plans keep the owner's bounds for
                    // good; trailing plans move them to the new reference
                    // ± their step, so no single run moves it further.
                    let rate = shares_per_cash_e9(shares_out, order.cash_amount).unwrap_or(0);
                    if rate > 0 {
                        let rate = apply_plan_fill(&mut plan, rate, step, hard)?;
                        plan.fills = plan.fills.saturating_add(1);
                        plan.last_fill_ts = now;
                        let mut data = plan_info.try_borrow_mut_data()?;
                        let mut writer: &mut [u8] = &mut data;
                        plan.try_serialize(&mut writer)?;
                        new_plan_rate = Some(rate);
                    }
                }
            }
        }

        let basket = &mut ctx.accounts.basket;
        basket.mint_count = basket.mint_count.saturating_add(1);
        accrue_protocol_fee(basket, basket_key, protocol_shares)?;

        // Every share issuance emits SharesMinted, so supply can be rebuilt
        // from events alone; OrderFilled carries the desk-specific detail.
        emit!(SharesMinted {
            basket: basket_key,
            depositor: ctx.accounts.filler.key(),
            shares_issued: shares_out,
            creator_fee_shares: fee_shares,
            amounts: deposited,
        });
        emit!(OrderFilled {
            order: order_key,
            basket: basket_key,
            buyer: order.buyer,
            filler: ctx.accounts.filler.key(),
            plan: order.plan,
            shares: shares_out,
            creator_fee_shares: fee_shares,
            cash: order.cash_amount,
            cash_paid: paid,
            price: price_per_share(order.cash_amount, shares_out),
            filled_at: now,
            plan_ref_shares_per_cash_e9: new_plan_rate,
        });
        Ok(())
    }

    /// Cancel an order and refund its cash to the buyer. The buyer may cancel
    /// at any time; after `end_ts` anyone may, as a clean-up crank. The refund
    /// always goes to a cash account the buyer owns.
    pub fn cancel_order<'info>(ctx: Context<'_, '_, 'info, 'info, CancelOrder<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let order: Order = (**ctx.accounts.order).clone();
        let by = ctx.accounts.caller.key();
        let expired = now > order.end_ts;
        require!(by == order.buyer || expired, SheafError::OrderNotExpired);
        // Anyone else's refund lands only in the buyer's canonical cash account,
        // the one every client reads, never in a side account a third party
        // opened in the buyer's name.
        if by != order.buyer {
            let (canonical, _) = Pubkey::find_program_address(
                &[
                    order.buyer.as_ref(),
                    ctx.accounts.cash_token_program.key().as_ref(),
                    order.cash_mint.as_ref(),
                ],
                &anchor_spl::associated_token::ID,
            );
            require!(
                ctx.accounts.buyer_cash_account.key() == canonical,
                SheafError::RefundNotToBuyerAta
            );
        }

        let refunded = drain_and_close_escrow(
            &order,
            ctx.accounts.order.key(),
            ctx.accounts.order.to_account_info(),
            &ctx.accounts.escrow,
            ctx.accounts.cash_mint.to_account_info(),
            ctx.accounts.cash_mint.decimals,
            ctx.accounts.buyer_cash_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            ctx.remaining_accounts,
        )?;

        emit!(OrderCancelled {
            order: ctx.accounts.order.key(),
            basket: order.basket,
            buyer: order.buyer,
            plan: order.plan,
            by,
            cash_refunded: refunded,
            expired,
        });
        Ok(())
    }

    // ---------------------------------------------------------------- plans

    /// Open a recurring buy and delegate `cash_per_run * runs` of the owner's
    /// cash account to the plan PDA, in one instruction.
    ///
    /// `min_ref_shares_per_cash_e9` and `max_ref_shares_per_cash_e9` are the
    /// owner's hard limits (`min <= ref <= max`): no run's auction ends below
    /// `min`, and no fill moves the reference outside `[min, max]`, ever,
    /// trailing or not. They change only through `update_plan`.
    ///
    /// `trail_step_bps` (0 to 5,000) chooses how the working bounds behave:
    /// 0 keeps them at the hard limits for good (fixed bounds); a step `s`
    /// moves them after every fill to `ref × (1 ± s)` intersected with the
    /// hard limits, so the plan follows the market inside the owner's limits
    /// and no single run moves the reference by more than `s`.
    #[allow(clippy::too_many_arguments)]
    pub fn open_plan(
        ctx: Context<OpenPlan>,
        plan_id: u64,
        cash_per_run: u64,
        period_secs: i64,
        runs: u32,
        ref_shares_per_cash_e9: u64,
        band_bps: u16,
        auction_secs: i64,
        min_ref_shares_per_cash_e9: u64,
        max_ref_shares_per_cash_e9: u64,
        trail_step_bps: u16,
    ) -> Result<()> {
        require!(cash_per_run > 0, SheafError::ZeroCash);
        require!(period_secs > 0 && runs > 0, SheafError::BadPlanSchedule);
        require!(trail_step_bps <= MAX_TRAIL_STEP_BPS, SheafError::BadTrailStep);
        validate_plan_terms(
            cash_per_run,
            auction_secs,
            ref_shares_per_cash_e9,
            band_bps,
            min_ref_shares_per_cash_e9,
            max_ref_shares_per_cash_e9,
        )?;
        check_cash_mint_extensions(&ctx.accounts.cash_mint.to_account_info().try_borrow_data()?)?;
        let allowance = cash_per_run
            .checked_mul(runs as u64)
            .ok_or(SheafError::MathOverflow)?;

        let plan_key = ctx.accounts.plan.key();
        // An account has one delegate. Silently replacing someone else's live
        // allowance (another plan, another app) would break it, so refuse;
        // the client can prepend a `revoke` if that is what the owner wants.
        let cash = &ctx.accounts.owner_cash_account;
        let current: Option<Pubkey> = cash.delegate.into();
        if let Some(d) = current {
            require!(
                d == plan_key || cash.delegated_amount == 0,
                SheafError::DelegateInUse
            );
        }

        token_interface::approve_checked(
            CpiContext::new(
                ctx.accounts.cash_token_program.to_account_info(),
                ApproveChecked {
                    to: ctx.accounts.owner_cash_account.to_account_info(),
                    mint: ctx.accounts.cash_mint.to_account_info(),
                    delegate: ctx.accounts.plan.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            allowance,
            ctx.accounts.cash_mint.decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let plan = &mut ctx.accounts.plan;
        plan.owner = ctx.accounts.owner.key();
        plan.basket = ctx.accounts.basket.key();
        plan.cash_mint = ctx.accounts.cash_mint.key();
        plan.cash_token_program = ctx.accounts.cash_token_program.key();
        plan.cash_account = ctx.accounts.owner_cash_account.key();
        plan.plan_id = plan_id;
        plan.cash_per_run = cash_per_run;
        plan.period_secs = period_secs;
        plan.runs_total = runs;
        plan.runs_left = runs;
        plan.next_run_ts = now;
        plan.ref_shares_per_cash_e9 = ref_shares_per_cash_e9;
        plan.band_bps = band_bps;
        plan.auction_secs = auction_secs;
        plan.last_order = None;
        plan.fills = 0;
        plan.last_fill_ts = 0;
        plan.created_at = now;
        plan.bump = ctx.bumps.plan;
        plan.min_ref_shares_per_cash_e9 = min_ref_shares_per_cash_e9;
        plan.max_ref_shares_per_cash_e9 = max_ref_shares_per_cash_e9;

        emit!(PlanOpened {
            plan: plan_key,
            basket: plan.basket,
            owner: plan.owner,
            cash_mint: plan.cash_mint,
            cash_account: plan.cash_account,
            cash_per_run,
            period_secs,
            runs,
            ref_shares_per_cash_e9,
            band_bps,
            auction_secs,
            allowance,
            min_ref_shares_per_cash_e9,
            max_ref_shares_per_cash_e9,
        });

        // The trailing step and the owner's hard limits live after the struct,
        // so plans opened before them (and their clients) are untouched.
        {
            let info = ctx.accounts.plan.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            write_plan_tail(&mut data, trail_step_bps, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9);
        }
        emit!(PlanTrail {
            plan: plan_key,
            step_bps: trail_step_bps,
        });
        Ok(())
    }

    /// Owner-only: re-centre a plan. Resets the reference rate, the band, the
    /// auction length and the owner's rate bounds, under the same rules as
    /// `open_plan`. This is how an owner un-sticks a plan the market has moved
    /// away from, or tightens it after seeing a fill they did not like. The
    /// schedule and the remaining allowance are untouched.
    pub fn update_plan(
        ctx: Context<UpdatePlan>,
        ref_shares_per_cash_e9: u64,
        band_bps: u16,
        auction_secs: i64,
        min_ref_shares_per_cash_e9: u64,
        max_ref_shares_per_cash_e9: u64,
    ) -> Result<()> {
        let plan = &mut ctx.accounts.plan;
        validate_plan_terms(
            plan.cash_per_run,
            auction_secs,
            ref_shares_per_cash_e9,
            band_bps,
            min_ref_shares_per_cash_e9,
            max_ref_shares_per_cash_e9,
        )?;
        plan.ref_shares_per_cash_e9 = ref_shares_per_cash_e9;
        plan.band_bps = band_bps;
        plan.auction_secs = auction_secs;
        plan.min_ref_shares_per_cash_e9 = min_ref_shares_per_cash_e9;
        plan.max_ref_shares_per_cash_e9 = max_ref_shares_per_cash_e9;
        // A new terms epoch: a fill of an order the plan placed before this
        // re-centre no longer moves the reference (`fill_order` updates the
        // plan only from orders created at or after `created_at`), so a stale
        // order cannot undo the owner's update. It starts one second ahead,
        // so an order created in the same second as the update (which may
        // predate it) is treated as stale too. The plan's opening time stays
        // in the `PlanOpened` event.
        plan.created_at = Clock::get()?
            .unix_timestamp
            .checked_add(1)
            .ok_or(SheafError::MathOverflow)?;

        emit!(PlanUpdated {
            plan: plan.key(),
            owner: plan.owner,
            ref_shares_per_cash_e9,
            band_bps,
            auction_secs,
            min_ref_shares_per_cash_e9,
            max_ref_shares_per_cash_e9,
        });
        // The re-centred bounds are the owner's new hard limits.
        {
            let info = ctx.accounts.plan.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            if data.len() >= PLAN_TAIL_AT + PLAN_TAIL_LEN {
                let step = plan_trail_step(&data);
                write_plan_tail(&mut data, step, min_ref_shares_per_cash_e9, max_ref_shares_per_cash_e9);
            }
        }
        Ok(())
    }

    /// Turn one slice of a plan into a desk order. Permissionless: whoever
    /// cranks pays the order's rent and gets it back when the order closes.
    pub fn run_plan(ctx: Context<RunPlan>, nonce: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let plan = &ctx.accounts.plan;
        require!(plan.runs_left > 0, SheafError::PlanExhausted);
        require!(now >= plan.next_run_ts, SheafError::PlanTooEarly);

        let plan_key = plan.key();
        let plan_id_bytes = plan.plan_id.to_le_bytes();
        let plan_bump = [plan.bump];
        let plan_seeds: &[&[u8]] = &[
            b"plan",
            plan.basket.as_ref(),
            plan.owner.as_ref(),
            &plan_id_bytes,
            &plan_bump,
        ];
        // The plan PDA moves the owner's cash as its SPL delegate; the token
        // program enforces and decrements the allowance.
        let escrowed = fund_escrow(
            ctx.accounts.owner_cash_account.to_account_info(),
            &ctx.accounts.cash_mint,
            &mut ctx.accounts.escrow,
            ctx.accounts.plan.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            ctx.accounts.plan.cash_per_run,
            &[plan_seeds],
        )?;

        let plan = &ctx.accounts.plan;
        let (start_shares, end_shares) = plan_auction(
            escrowed,
            plan.ref_shares_per_cash_e9,
            plan.band_bps,
            plan.min_ref_shares_per_cash_e9,
        )?;
        require!(end_shares > 0, SheafError::PlanAmountTooSmall);
        let end_ts = now
            .checked_add(plan.auction_secs)
            .ok_or(SheafError::MathOverflow)?;
        validate_auction(start_shares, end_shares, now, end_ts, now)?;

        let order_key = ctx.accounts.order.key();
        let order = &mut ctx.accounts.order;
        order.basket = plan.basket;
        order.buyer = plan.owner;
        order.rent_payer = ctx.accounts.cranker.key();
        order.cash_mint = plan.cash_mint;
        order.cash_token_program = plan.cash_token_program;
        order.plan = Some(plan_key);
        order.nonce = nonce;
        order.cash_amount = escrowed;
        order.start_shares = start_shares;
        order.end_shares = end_shares;
        order.start_ts = now;
        order.end_ts = end_ts;
        order.created_at = now;
        order.bump = ctx.bumps.order;
        emit_order_placed(order, order_key);

        // Next slot is one period after the scheduled one. If the crank ran
        // late enough to miss slots, they are not replayed in a burst: the
        // schedule restarts one period from now and no run is lost.
        let plan = &mut ctx.accounts.plan;
        let run = plan.runs_total - plan.runs_left + 1;
        plan.runs_left -= 1;
        let mut next = plan
            .next_run_ts
            .checked_add(plan.period_secs)
            .ok_or(SheafError::MathOverflow)?;
        if next <= now {
            next = now.checked_add(plan.period_secs).ok_or(SheafError::MathOverflow)?;
        }
        plan.next_run_ts = next;
        plan.last_order = Some(order_key);

        emit!(PlanRun {
            plan: plan_key,
            order: order_key,
            run,
            cash: escrowed,
            start_shares,
            end_shares,
            start_ts: now,
            end_ts,
            ref_shares_per_cash_e9: plan.ref_shares_per_cash_e9,
            runs_left: plan.runs_left,
            next_run_ts: plan.next_run_ts,
        });
        Ok(())
    }

    /// Close a plan. Revokes the plan's allowance on the owner's cash account
    /// when it is still the delegate there; orders already placed by the plan
    /// stay open and can still be filled or cancelled.
    pub fn close_plan(ctx: Context<ClosePlan>) -> Result<()> {
        let plan = &ctx.accounts.plan;
        let plan_key = plan.key();
        let revoked = revoke_if_delegate(
            ctx.accounts.owner_cash_account.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            &plan_key,
            ctx.accounts.owner.to_account_info(),
        )?;

        emit!(PlanClosed {
            plan: plan_key,
            owner: plan.owner,
            runs_done: plan.runs_total - plan.runs_left,
            runs_left: plan.runs_left,
            revoked,
        });
        Ok(())
    }

    // ----------------------------------------------------------- sell desk

    /// Escrow `shares` and post a Dutch auction for dollars: the cash the
    /// seller must **receive** is `start_cash` until `start_ts`, decays
    /// linearly to `end_cash` at `end_ts`, and the order cannot be filled
    /// after `end_ts`. The seller's worst case is `end_cash`, their floor.
    /// No protocol fee: leaving a basket is free.
    #[allow(clippy::too_many_arguments)]
    pub fn place_sell_order(
        ctx: Context<PlaceSellOrder>,
        nonce: u64,
        shares: u64,
        start_cash: u64,
        end_cash: u64,
        start_ts: i64,
        end_ts: i64,
    ) -> Result<()> {
        require!(shares > 0, SheafError::ZeroShares);
        let now = Clock::get()?.unix_timestamp;
        validate_auction(start_cash, end_cash, start_ts, end_ts, now)?;
        require_fresh_start(start_ts, now)?;
        // The seller is paid in this cash: nobody may be able to seize it,
        // block it, or change its fee once a filler has priced the order.
        check_cash_mint_extensions(&ctx.accounts.cash_mint.to_account_info().try_borrow_data()?)?;

        let before = ctx.accounts.escrow.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.share_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.seller_share_account.to_account_info(),
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            shares,
            SHARE_DECIMALS,
        )?;
        ctx.accounts.escrow.reload()?;
        let escrowed = ctx
            .accounts
            .escrow
            .amount
            .checked_sub(before)
            .ok_or(SheafError::MathOverflow)?;
        require!(escrowed > 0, SheafError::ZeroShares);

        let key = ctx.accounts.sell_order.key();
        let order = &mut ctx.accounts.sell_order;
        order.basket = ctx.accounts.basket.key();
        order.seller = ctx.accounts.seller.key();
        order.rent_payer = ctx.accounts.seller.key();
        order.cash_mint = ctx.accounts.cash_mint.key();
        order.cash_token_program = ctx.accounts.cash_token_program.key();
        order.nonce = nonce;
        order.shares = escrowed;
        order.start_cash = start_cash;
        order.end_cash = end_cash;
        order.start_ts = start_ts;
        order.end_ts = end_ts;
        order.created_at = now;
        order.bump = ctx.bumps.sell_order;

        emit!(SellOrderPlaced {
            sell_order: key,
            basket: order.basket,
            seller: order.seller,
            cash_mint: order.cash_mint,
            nonce,
            shares: escrowed,
            start_cash,
            end_cash,
            start_ts,
            end_ts,
        });
        Ok(())
    }

    /// Fill a sell order: the filler pays the seller the auction's current
    /// cash (into the seller's canonical cash account, created here if need
    /// be, grossed up for any transfer fee so the seller nets it) and takes the
    /// escrowed shares. Permissionless. The filler may redeem the shares in
    /// kind with `redeem_shares` in the same transaction.
    pub fn fill_sell_order<'info>(ctx: Context<'_, '_, 'info, 'info, FillSellOrder<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.sell_order.key();
        let order: SellOrder = (**ctx.accounts.sell_order).clone();
        require!(now <= order.end_ts, SheafError::OrderExpired);
        check_cash_mint_extensions(&ctx.accounts.cash_mint.to_account_info().try_borrow_data()?)?;

        let cash_due = required_shares(order.start_cash, order.end_cash, order.start_ts, order.end_ts, now)?;
        let send = gross_for_transfer_fee(
            &ctx.accounts.cash_mint.to_account_info(),
            cash_due,
            Clock::get()?.epoch,
        )?;
        let before = ctx.accounts.seller_cash_account.amount;
        memo_if_required(&ctx.accounts.seller_cash_account.to_account_info(), ctx.remaining_accounts)?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.cash_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.filler_cash_account.to_account_info(),
                    mint: ctx.accounts.cash_mint.to_account_info(),
                    to: ctx.accounts.seller_cash_account.to_account_info(),
                    authority: ctx.accounts.filler.to_account_info(),
                },
            ),
            send,
            ctx.accounts.cash_mint.decimals,
        )?;
        ctx.accounts.seller_cash_account.reload()?;
        let received = ctx
            .accounts
            .seller_cash_account
            .amount
            .checked_sub(before)
            .ok_or(SheafError::MathOverflow)?;
        require!(received >= cash_due, SheafError::SellerPaidShort);

        // Only then do the shares leave escrow.
        let shares = release_sell_escrow(
            &order,
            key,
            ctx.accounts.sell_order.to_account_info(),
            &ctx.accounts.escrow,
            &ctx.accounts.share_mint,
            ctx.accounts.filler_share_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.share_token_program.to_account_info(),
            ctx.remaining_accounts,
        )?;

        emit!(SellOrderFilled {
            sell_order: key,
            basket: order.basket,
            seller: order.seller,
            filler: ctx.accounts.filler.key(),
            shares,
            cash: cash_due,
            cash_paid: send,
            price: if order.shares == 0 { u64::MAX } else { mul_div_floor(cash_due, ONE_SHARE, order.shares).unwrap_or(u64::MAX) },
            filled_at: now,
        });
        Ok(())
    }

    /// Cancel a sell order and return the shares. The seller may cancel at
    /// any time; after `end_ts` anyone may, and then the shares go only to
    /// the seller's canonical share account.
    pub fn cancel_sell_order<'info>(ctx: Context<'_, '_, 'info, 'info, CancelSellOrder<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.sell_order.key();
        let order: SellOrder = (**ctx.accounts.sell_order).clone();
        let by = ctx.accounts.caller.key();
        let expired = now > order.end_ts;
        require!(by == order.seller || expired, SheafError::OrderNotExpired);
        if by != order.seller {
            let (canonical, _) = Pubkey::find_program_address(
                &[
                    order.seller.as_ref(),
                    ctx.accounts.share_token_program.key().as_ref(),
                    ctx.accounts.share_mint.key().as_ref(),
                ],
                &anchor_spl::associated_token::ID,
            );
            require!(
                ctx.accounts.seller_share_account.key() == canonical,
                SheafError::RefundNotToSellerAta
            );
        }
        let shares = release_sell_escrow(
            &order,
            key,
            ctx.accounts.sell_order.to_account_info(),
            &ctx.accounts.escrow,
            &ctx.accounts.share_mint,
            ctx.accounts.seller_share_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.share_token_program.to_account_info(),
            ctx.remaining_accounts,
        )?;
        emit!(SellOrderCancelled {
            sell_order: key,
            basket: order.basket,
            seller: order.seller,
            by,
            shares_returned: shares,
            expired,
        });
        Ok(())
    }

    /// Mint a basket's accrued protocol fee to the treasury's share account and
    /// zero the counter. Permissionless: the destination is fixed, so anyone
    /// may crank it (create the treasury's associated share account first).
    pub fn claim_protocol_fee(ctx: Context<ClaimProtocolFee>) -> Result<()> {
        let basket = &ctx.accounts.basket;
        let basket_key = basket.key();
        let shares = basket.protocol_fee_accrued;
        require!(shares > 0, SheafError::NothingToClaim);
        // The same check every issuance makes: no lever over the shares minted.
        check_share_mint_extensions(&ctx.accounts.share_mint.to_account_info().try_borrow_data()?)?;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"basket",
            basket.creator.as_ref(),
            basket.symbol.as_bytes(),
            &[basket.bump],
        ]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.treasury_share_account.to_account_info(),
                    authority: ctx.accounts.basket.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;
        let basket = &mut ctx.accounts.basket;
        basket.protocol_fee_accrued = 0;
        emit!(ProtocolFeeClaimed {
            basket: basket_key,
            treasury_share_account: ctx.accounts.treasury_share_account.key(),
            shares,
        });
        Ok(())
    }

    /// Close a plan written by the pre-hardening release, whose account is
    /// 16 bytes shorter than today's `Plan` and so no longer decodes. Owner
    /// only; revokes the allowance like `close_plan` and returns the rent.
    pub fn close_legacy_plan(ctx: Context<CloseLegacyPlan>) -> Result<()> {
        let plan_info = ctx.accounts.plan.to_account_info();
        let owner_key = ctx.accounts.owner.key();
        let (runs_total, runs_left) = {
            let data = plan_info.try_borrow_data()?;
            require!(
                plan_info.owner == &crate::ID
                    && data.len() == LEGACY_PLAN_LEN
                    && data[..8] == *Plan::DISCRIMINATOR,
                SheafError::NotLegacyPlan
            );
            let key_at = |o: usize| Pubkey::new_from_array(data[o..o + 32].try_into().unwrap());
            require!(key_at(8) == owner_key, SheafError::PlanAccountMismatch);
            require!(
                key_at(104) == ctx.accounts.cash_token_program.key(),
                SheafError::WrongTokenProgram
            );
            require!(
                key_at(136) == ctx.accounts.owner_cash_account.key(),
                SheafError::PlanAccountMismatch
            );
            // runs_total and runs_left sit after plan_id, cash_per_run and period.
            let u32_at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
            (u32_at(192), u32_at(196))
        };

        let revoked = revoke_if_delegate(
            ctx.accounts.owner_cash_account.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
            &plan_info.key(),
            ctx.accounts.owner.to_account_info(),
        )?;

        // Hand the rent back and give the account to the system program.
        let owner_info = ctx.accounts.owner.to_account_info();
        let lamports = plan_info.lamports();
        **owner_info.try_borrow_mut_lamports()? = owner_info
            .lamports()
            .checked_add(lamports)
            .ok_or(SheafError::MathOverflow)?;
        **plan_info.try_borrow_mut_lamports()? = 0;
        plan_info.assign(&anchor_lang::solana_program::system_program::ID);
        plan_info.resize(0)?;

        emit!(PlanClosed {
            plan: plan_info.key(),
            owner: owner_key,
            runs_done: runs_total.saturating_sub(runs_left),
            runs_left,
            revoked,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
#[instruction(name: String, symbol: String)]
pub struct CreateBasket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = Basket::SPACE,
        seeds = [b"basket", creator.key().as_ref(), symbol.as_bytes()],
        bump,
    )]
    pub basket: Account<'info, Basket>,

    /// CHECK: validated field by field in the handler.
    pub share_mint: UncheckedAccount<'info>,

    pub component_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub basket: Account<'info, Basket>,

    #[account(mut, address = basket.share_mint @ SheafError::ShareMintMismatch)]
    /// CHECK: pinned to the basket's recorded share mint.
    pub share_mint: UncheckedAccount<'info>,

    pub depositor: Signer<'info>,

    #[account(mut)]
    /// CHECK: ownership and mint verified in the handler.
    pub depositor_share_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: only required when a creator fee is charged; mint and owner
    /// (must be the basket creator) verified in the handler.
    pub creator_share_account: Option<UncheckedAccount<'info>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub component_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut)]
    pub basket: Account<'info, Basket>,

    #[account(mut, address = basket.share_mint @ SheafError::ShareMintMismatch)]
    /// CHECK: pinned to the basket's recorded share mint.
    pub share_mint: UncheckedAccount<'info>,

    pub owner: Signer<'info>,

    #[account(mut)]
    /// CHECK: burn authority is the owner; the token program enforces the rest.
    pub owner_share_account: UncheckedAccount<'info>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub component_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    pub basket: Box<Account<'info, Basket>>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"order", basket.key().as_ref(), buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,

    #[account(mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = cash_mint,
        token::authority = buyer,
        token::token_program = cash_token_program,
    )]
    pub buyer_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The order PDA's own associated token account. `init_if_needed` so that
    /// someone creating it first (it is a predictable address) cannot block
    /// the order; the amount escrowed is measured as a balance delta.
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = cash_mint,
        associated_token::authority = order,
        associated_token::token_program = cash_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub cash_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub filler: Signer<'info>,

    #[account(
        mut,
        close = rent_payer,
        has_one = basket @ SheafError::OrderAccountMismatch,
        has_one = buyer @ SheafError::OrderAccountMismatch,
        has_one = rent_payer @ SheafError::OrderAccountMismatch,
        has_one = cash_mint @ SheafError::OrderAccountMismatch,
    )]
    pub order: Box<Account<'info, Order>>,

    #[account(mut)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.share_mint @ SheafError::ShareMintMismatch)]
    /// CHECK: pinned to the basket's recorded share mint.
    pub share_mint: UncheckedAccount<'info>,

    /// CHECK: pinned to `order.buyer`.
    pub buyer: UncheckedAccount<'info>,

    /// Shares can only land in the buyer's canonical share account.
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = buyer,
        associated_token::token_program = share_token_program,
    )]
    pub buyer_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: only required when a creator fee is charged; mint and owner
    /// (must be the basket creator) verified in the handler.
    pub creator_share_account: Option<UncheckedAccount<'info>>,

    #[account(mut, mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = cash_mint,
        associated_token::authority = order,
        associated_token::token_program = cash_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Where the filler wants the cash. The filler signs, so it is theirs to pick.
    #[account(
        mut,
        token::mint = cash_mint,
        token::token_program = cash_token_program,
    )]
    pub filler_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: pinned to `order.rent_payer`; receives the order's rent.
    pub rent_payer: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: required iff the order came from a plan; pinned to `order.plan`
    /// and decoded in the handler (it may have been closed since).
    pub plan: Option<UncheckedAccount<'info>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub component_token_program: Interface<'info, TokenInterface>,
    pub cash_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = rent_payer,
        has_one = buyer @ SheafError::OrderAccountMismatch,
        has_one = rent_payer @ SheafError::OrderAccountMismatch,
        has_one = cash_mint @ SheafError::OrderAccountMismatch,
    )]
    pub order: Box<Account<'info, Order>>,

    /// CHECK: pinned to `order.buyer`.
    pub buyer: UncheckedAccount<'info>,

    #[account(mut, mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = cash_mint,
        associated_token::authority = order,
        associated_token::token_program = cash_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Any cash account the buyer owns; a stranger cannot redirect the refund.
    #[account(
        mut,
        token::mint = cash_mint,
        token::authority = buyer,
        token::token_program = cash_token_program,
    )]
    pub buyer_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: pinned to `order.rent_payer`; receives the order's rent.
    pub rent_payer: UncheckedAccount<'info>,

    pub cash_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(plan_id: u64)]
pub struct OpenPlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub basket: Box<Account<'info, Basket>>,

    #[account(
        init,
        payer = owner,
        space = PLAN_TAIL_AT + PLAN_TAIL_LEN,
        seeds = [b"plan", basket.key().as_ref(), owner.key().as_ref(), &plan_id.to_le_bytes()],
        bump,
    )]
    pub plan: Box<Account<'info, Plan>>,

    #[account(mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = cash_mint,
        token::authority = owner,
        token::token_program = cash_token_program,
    )]
    pub owner_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub cash_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RunPlan<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(mut, has_one = cash_mint @ SheafError::PlanAccountMismatch)]
    pub plan: Box<Account<'info, Plan>>,

    #[account(
        init,
        payer = cranker,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"plan_order", plan.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,

    #[account(mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = plan.cash_account @ SheafError::PlanAccountMismatch)]
    pub owner_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = cash_mint,
        associated_token::authority = order,
        associated_token::token_program = cash_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub cash_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, close = owner, has_one = owner @ SheafError::PlanAccountMismatch)]
    pub plan: Box<Account<'info, Plan>>,

    #[account(mut, address = plan.cash_account @ SheafError::PlanAccountMismatch)]
    /// CHECK: pinned to the plan's cash account; it may since have been
    /// closed, so it is decoded leniently in the handler.
    pub owner_cash_account: UncheckedAccount<'info>,

    #[account(address = plan.cash_token_program @ SheafError::WrongTokenProgram)]
    pub cash_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdatePlan<'info> {
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SheafError::PlanAccountMismatch)]
    pub plan: Box<Account<'info, Plan>>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceSellOrder<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    pub basket: Box<Account<'info, Basket>>,

    #[account(
        init,
        payer = seller,
        space = 8 + SellOrder::INIT_SPACE,
        seeds = [b"sell", basket.key().as_ref(), seller.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub sell_order: Box<Account<'info, SellOrder>>,

    #[account(
        address = basket.share_mint @ SheafError::ShareMintMismatch,
        mint::token_program = share_token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = seller,
        token::token_program = share_token_program,
    )]
    pub seller_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The sell order's own share account. `init_if_needed`, so someone
    /// creating it first cannot block the order; measured by balance delta.
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = share_mint,
        associated_token::authority = sell_order,
        associated_token::token_program = share_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub cash_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillSellOrder<'info> {
    /// Pays the seller, and the rent of the seller's cash account if it is new.
    #[account(mut)]
    pub filler: Signer<'info>,

    #[account(
        mut,
        close = rent_payer,
        has_one = basket @ SheafError::OrderAccountMismatch,
        has_one = seller @ SheafError::OrderAccountMismatch,
        has_one = rent_payer @ SheafError::OrderAccountMismatch,
        has_one = cash_mint @ SheafError::OrderAccountMismatch,
    )]
    pub sell_order: Box<Account<'info, SellOrder>>,

    pub basket: Box<Account<'info, Basket>>,

    #[account(
        address = basket.share_mint @ SheafError::ShareMintMismatch,
        mint::token_program = share_token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = sell_order,
        associated_token::token_program = share_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Where the filler wants the shares. The filler signs, so it is theirs to pick.
    #[account(
        mut,
        token::mint = share_mint,
        token::token_program = share_token_program,
    )]
    pub filler_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: pinned to `sell_order.seller`.
    pub seller: UncheckedAccount<'info>,

    /// The seller is paid only into their canonical cash account, which the
    /// filler creates if it does not exist yet.
    #[account(
        init_if_needed,
        payer = filler,
        associated_token::mint = cash_mint,
        associated_token::authority = seller,
        associated_token::token_program = cash_token_program,
    )]
    pub seller_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mint::token_program = cash_token_program)]
    pub cash_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = cash_mint,
        token::authority = filler,
        token::token_program = cash_token_program,
    )]
    pub filler_cash_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: pinned to `sell_order.rent_payer`; receives the order's rent.
    pub rent_payer: UncheckedAccount<'info>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub cash_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSellOrder<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = rent_payer,
        has_one = basket @ SheafError::OrderAccountMismatch,
        has_one = seller @ SheafError::OrderAccountMismatch,
        has_one = rent_payer @ SheafError::OrderAccountMismatch,
    )]
    pub sell_order: Box<Account<'info, SellOrder>>,

    pub basket: Box<Account<'info, Basket>>,

    #[account(
        address = basket.share_mint @ SheafError::ShareMintMismatch,
        mint::token_program = share_token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = sell_order,
        associated_token::token_program = share_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: pinned to `sell_order.seller`.
    pub seller: UncheckedAccount<'info>,

    /// A share account the seller owns; for anyone but the seller, their
    /// canonical one (checked in the handler).
    #[account(
        mut,
        token::mint = share_mint,
        token::authority = seller,
        token::token_program = share_token_program,
    )]
    pub seller_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: pinned to `sell_order.rent_payer`; receives the order's rent.
    pub rent_payer: UncheckedAccount<'info>,

    pub share_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimProtocolFee<'info> {
    #[account(mut)]
    pub basket: Account<'info, Basket>,

    #[account(mut, address = basket.share_mint @ SheafError::ShareMintMismatch)]
    /// CHECK: pinned to the basket's recorded share mint.
    pub share_mint: UncheckedAccount<'info>,

    #[account(address = TREASURY @ SheafError::TreasuryMismatch)]
    /// CHECK: pinned to the treasury constant.
    pub treasury: UncheckedAccount<'info>,

    /// The treasury's canonical share account, and nowhere else.
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = treasury,
        associated_token::token_program = share_token_program,
    )]
    pub treasury_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub share_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseLegacyPlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    /// CHECK: a pre-hardening plan; owner, length, discriminator and every
    /// field used are checked byte by byte in the handler.
    pub plan: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: must equal the legacy plan's recorded cash account (checked in
    /// the handler); decoded leniently, as it may have been closed.
    pub owner_cash_account: UncheckedAccount<'info>,

    pub cash_token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Component {
    pub mint: Pubkey,
    /// Raw token units of this component backing one whole share.
    pub units_per_share: u64,
    /// Target weight at creation, recorded so drift is measurable later.
    pub weight_bps: u16,
    pub decimals: u8,
    pub _padding: [u8; 5],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ComponentArg {
    pub mint: Pubkey,
    pub units_per_share: u64,
    pub weight_bps: u16,
}

#[account]
pub struct Basket {
    pub creator: Pubkey,
    pub share_mint: Pubkey,
    pub token_program: Pubkey,
    pub name: String,
    pub symbol: String,
    pub creator_fee_bps: u16,
    pub component_count: u8,
    pub components: [Component; MAX_COMPONENTS],
    pub created_at: i64,
    pub mint_count: u64,
    pub redeem_count: u64,
    pub bump: u8,
    /// The protocol's creation fee, fixed at `create_basket` and never
    /// changed. Appended into the account's headroom, so a basket created
    /// before it existed reads its zeroed tail as 0: no protocol fee, ever.
    pub protocol_fee_bps: u16,
    /// Protocol-fee shares created and backed in the vault but not yet minted;
    /// `claim_protocol_fee` mints them to the treasury. The vault backs
    /// `supply + protocol_fee_accrued`.
    pub protocol_fee_accrued: u64,
}

impl Basket {
    pub const SPACE: usize = 8      // discriminator
        + 32 + 32 + 32              // creator, share_mint, token_program
        + 4 + MAX_NAME_LEN          // name
        + 4 + MAX_SYMBOL_LEN        // symbol
        + 2 + 1                     // creator_fee_bps, component_count
        + MAX_COMPONENTS * 48       // components
        + 8 + 8 + 8                 // created_at, mint_count, redeem_count
        + 1                         // bump
        + 64; // headroom: protocol_fee_bps and protocol_fee_accrued use 10 of it
}

/// A cash order on the desk. PDA: `["order", basket, buyer, nonce_le]` for
/// `place_order`, `["plan_order", plan, nonce_le]` for `run_plan` (orders a
/// plan placed before the hardening release used the first form).
/// Its escrow is the order PDA's associated token account for `cash_mint`.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub basket: Pubkey,
    /// Receives the shares (in their canonical share ATA) and any refund.
    pub buyer: Pubkey,
    /// Paid the order's and escrow's rent; gets it back when the order closes.
    /// The buyer for `place_order`, the cranker for `run_plan`.
    pub rent_payer: Pubkey,
    pub cash_mint: Pubkey,
    pub cash_token_program: Pubkey,
    /// The plan that placed this order, if any.
    pub plan: Option<Pubkey>,
    pub nonce: u64,
    /// Cash actually received into escrow (net of any Token-2022 transfer fee).
    pub cash_amount: u64,
    /// Shares the buyer receives, net of the creator fee, at `start_ts`.
    pub start_shares: u64,
    /// Shares the buyer receives at `end_ts`: the buyer's floor.
    pub end_shares: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub created_at: i64,
    pub bump: u8,
}

/// A recurring buy. PDA: `["plan", basket, owner, plan_id_le]`. It is the SPL
/// delegate of `cash_account` for the remaining allowance.
#[account]
#[derive(InitSpace)]
pub struct Plan {
    pub owner: Pubkey,
    pub basket: Pubkey,
    pub cash_mint: Pubkey,
    pub cash_token_program: Pubkey,
    pub cash_account: Pubkey,
    pub plan_id: u64,
    pub cash_per_run: u64,
    pub period_secs: i64,
    pub runs_total: u32,
    pub runs_left: u32,
    pub next_run_ts: i64,
    /// Raw share units per raw cash unit, times 10^9. Follows every fill.
    pub ref_shares_per_cash_e9: u64,
    pub band_bps: u16,
    pub auction_secs: i64,
    pub last_order: Option<Pubkey>,
    pub fills: u32,
    pub last_fill_ts: i64,
    pub created_at: i64,
    pub bump: u8,
    /// The worst rate the owner accepts: no run's auction ends below
    /// `cash × min / 10^9` shares, and fills never move the reference under it.
    pub min_ref_shares_per_cash_e9: u64,
    /// Fills never move the reference above this.
    pub max_ref_shares_per_cash_e9: u64,
}

/// A holder's offer to sell shares for cash, escrowed in the sell order's
/// own share account (its associated token account for the share mint).
#[account]
#[derive(InitSpace)]
pub struct SellOrder {
    pub basket: Pubkey,
    /// Receives the cash (in their canonical cash account) or the shares back.
    pub seller: Pubkey,
    /// Paid the order's and escrow's rent; gets both back when it closes.
    pub rent_payer: Pubkey,
    pub cash_mint: Pubkey,
    pub cash_token_program: Pubkey,
    pub nonce: u64,
    /// Shares escrowed.
    pub shares: u64,
    /// Cash the seller must receive at `start_ts`.
    pub start_cash: u64,
    /// Cash the seller must receive at `end_ts`: the seller's floor.
    pub end_cash: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub created_at: i64,
    pub bump: u8,
}

/// Where a plan's tail (`trail_step_bps`) starts: right after the struct.
pub const PLAN_TAIL_AT: usize = 8 + Plan::INIT_SPACE;

/// A plan's trailing step, from its tail; 0 (fixed bounds) when it has none.
pub fn plan_trail_step(data: &[u8]) -> u16 {
    match data.get(PLAN_TAIL_AT..PLAN_TAIL_AT + 2) {
        Some(b) => u16::from_le_bytes([b[0], b[1]]),
        None => 0,
    }
}

/// A plan's hard limits `(min, max)`, from its tail; `None` for a plan
/// opened before they existed.
pub fn plan_hard_limits(data: &[u8]) -> Option<(u64, u64)> {
    let b = data.get(PLAN_TAIL_AT + 8..PLAN_TAIL_AT + 24)?;
    Some((
        u64::from_le_bytes(b[0..8].try_into().unwrap()),
        u64::from_le_bytes(b[8..16].try_into().unwrap()),
    ))
}

fn write_plan_tail(data: &mut [u8], step: u16, hard_min: u64, hard_max: u64) {
    let t = &mut data[PLAN_TAIL_AT..PLAN_TAIL_AT + PLAN_TAIL_LEN];
    t[0..2].copy_from_slice(&step.to_le_bytes());
    t[8..16].copy_from_slice(&hard_min.to_le_bytes());
    t[16..24].copy_from_slice(&hard_max.to_le_bytes());
}

/// Record a plan fill at `rate`: clamp it into the plan's working bounds and
/// make it the reference. With a trailing step, the working bounds then move
/// to `rate × (1 ± step)` intersected with the owner's hard limits (`hard`),
/// so the next fill can move the reference at most `step`, and never outside
/// the owner's limits; with step 0 they stay where they are. Returns the
/// recorded rate.
pub fn apply_plan_fill(plan: &mut Plan, rate: u64, step_bps: u16, hard: Option<(u64, u64)>) -> Result<u64> {
    let rate = rate
        .max(plan.min_ref_shares_per_cash_e9)
        .min(plan.max_ref_shares_per_cash_e9);
    plan.ref_shares_per_cash_e9 = rate;
    if step_bps > 0 && (step_bps as u64) < BPS {
        let (hard_min, hard_max) = hard.unwrap_or((1, u64::MAX));
        let lo = mul_div_floor(rate, BPS - step_bps as u64, BPS)?.max(1).max(hard_min);
        let hi = mul_div_floor(rate, BPS + step_bps as u64, BPS)?.max(rate).min(hard_max);
        // `rate` lies inside the hard limits (it was clamped into working
        // bounds that never leave them), so lo <= rate <= hi.
        plan.min_ref_shares_per_cash_e9 = lo.min(rate);
        plan.max_ref_shares_per_cash_e9 = hi.max(rate);
    }
    Ok(rate)
}

/// An auction may start a little in the past (the transaction takes time to
/// land), but not so far that the filler gets most of the decay for free.
fn require_fresh_start(start_ts: i64, now: i64) -> Result<()> {
    require!(
        start_ts as i128 >= now as i128 - MAX_START_LAG_SECS as i128,
        SheafError::StaleAuctionStart
    );
    Ok(())
}

/// Whether a token account requires a memo on incoming transfers (a
/// Token-2022 account with MemoTransfer enabled). Read by extension number,
/// like the mint policies.
pub fn requires_incoming_memo(data: &[u8]) -> bool {
    const ACCOUNT_TYPE_AT: usize = 165;
    const MEMO_TRANSFER: u16 = 8;
    if data.len() <= ACCOUNT_TYPE_AT || data[ACCOUNT_TYPE_AT] != 2 {
        return false;
    }
    let mut at = ACCOUNT_TYPE_AT + 1;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        if ty == 0 {
            break;
        }
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        let start = at + 4;
        let Some(end) = start.checked_add(len) else { return false };
        if end > data.len() {
            return false;
        }
        if ty == MEMO_TRANSFER {
            return data.get(start) == Some(&1);
        }
        at = end;
    }
    false
}

/// Before a transfer into `to`: if it requires incoming memos, CPI a memo
/// (the token program checks the instruction just before the transfer), with
/// the Memo program taken from the remaining accounts (`MemoProgramRequired`
/// when it is not there). A refund, a sale or a release can then never be
/// blocked by the recipient turning memos on.
fn memo_if_required(to: &AccountInfo, remaining: &[AccountInfo]) -> Result<()> {
    let needs = to.owner == &spl_token_2022::ID && requires_incoming_memo(&to.try_borrow_data()?);
    if !needs {
        return Ok(());
    }
    let memo = remaining
        .iter()
        .find(|a| a.key == &MEMO_PROGRAM_ID)
        .ok_or(SheafError::MemoProgramRequired)?;
    invoke(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: MEMO_PROGRAM_ID,
            accounts: vec![],
            data: b"Sheaf".to_vec(),
        },
        &[memo.clone()],
    )?;
    Ok(())
}

/// Size of a `Plan` account written before `min_ref`/`max_ref` existed.
pub const LEGACY_PLAN_LEN: usize = 280;

// ------------------------------------------------------------------ events

/// A plan's trailing step, set when it is opened.
#[event]
pub struct PlanTrail {
    pub plan: Pubkey,
    pub step_bps: u16,
}

#[event]
pub struct SellOrderPlaced {
    pub sell_order: Pubkey,
    pub basket: Pubkey,
    pub seller: Pubkey,
    pub cash_mint: Pubkey,
    pub nonce: u64,
    pub shares: u64,
    pub start_cash: u64,
    pub end_cash: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct SellOrderFilled {
    pub sell_order: Pubkey,
    pub basket: Pubkey,
    pub seller: Pubkey,
    pub filler: Pubkey,
    /// Shares the filler took.
    pub shares: u64,
    /// Cash the seller received (the auction's count at `filled_at`).
    pub cash: u64,
    /// Cash the filler sent, grossed up for any transfer fee.
    pub cash_paid: u64,
    /// Raw cash per whole share, floored, saturating.
    pub price: u64,
    pub filled_at: i64,
}

#[event]
pub struct SellOrderCancelled {
    pub sell_order: Pubkey,
    pub basket: Pubkey,
    pub seller: Pubkey,
    pub by: Pubkey,
    pub shares_returned: u64,
    pub expired: bool,
}

/// The fee terms a basket was created with. Both are fixed for its lifetime.
#[event]
pub struct BasketFeeTerms {
    pub basket: Pubkey,
    pub creator_fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub treasury: Pubkey,
}

/// Protocol-fee shares created (and backed) by one issuance, not yet minted.
#[event]
pub struct ProtocolFeeAccrued {
    pub basket: Pubkey,
    pub shares: u64,
    pub accrued: u64,
}

/// Accrued protocol-fee shares minted to the treasury.
#[event]
pub struct ProtocolFeeClaimed {
    pub basket: Pubkey,
    pub treasury_share_account: Pubkey,
    pub shares: u64,
}

#[event]
pub struct BasketCreated {
    pub basket: Pubkey,
    pub creator: Pubkey,
    pub share_mint: Pubkey,
    pub name: String,
    pub symbol: String,
    pub component_count: u8,
}

#[event]
pub struct SharesMinted {
    pub basket: Pubkey,
    pub depositor: Pubkey,
    pub shares_issued: u64,
    pub creator_fee_shares: u64,
    pub amounts: [u64; MAX_COMPONENTS],
}

#[event]
pub struct SharesRedeemed {
    pub basket: Pubkey,
    pub owner: Pubkey,
    pub shares_burned: u64,
    pub amounts: [u64; MAX_COMPONENTS],
}

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub basket: Pubkey,
    pub buyer: Pubkey,
    pub plan: Option<Pubkey>,
    pub cash_mint: Pubkey,
    pub nonce: u64,
    pub cash_amount: u64,
    pub start_shares: u64,
    pub end_shares: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct OrderFilled {
    pub order: Pubkey,
    pub basket: Pubkey,
    pub buyer: Pubkey,
    pub filler: Pubkey,
    pub plan: Option<Pubkey>,
    /// Shares the buyer received.
    pub shares: u64,
    /// Shares the creator received on top; the filler delivered for both.
    pub creator_fee_shares: u64,
    /// Cash the order escrowed.
    pub cash: u64,
    /// Cash that left escrow to the filler (`cash` plus anything donated).
    pub cash_paid: u64,
    /// Raw cash units per whole share the buyer received, rounded down.
    pub price: u64,
    pub filled_at: i64,
    /// The plan's new reference rate, when this fill updated one.
    pub plan_ref_shares_per_cash_e9: Option<u64>,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub basket: Pubkey,
    pub buyer: Pubkey,
    pub plan: Option<Pubkey>,
    pub by: Pubkey,
    pub cash_refunded: u64,
    pub expired: bool,
}

#[event]
pub struct PlanOpened {
    pub plan: Pubkey,
    pub basket: Pubkey,
    pub owner: Pubkey,
    pub cash_mint: Pubkey,
    pub cash_account: Pubkey,
    pub cash_per_run: u64,
    pub period_secs: i64,
    pub runs: u32,
    pub ref_shares_per_cash_e9: u64,
    pub band_bps: u16,
    pub auction_secs: i64,
    pub allowance: u64,
    pub min_ref_shares_per_cash_e9: u64,
    pub max_ref_shares_per_cash_e9: u64,
}

#[event]
pub struct PlanUpdated {
    pub plan: Pubkey,
    pub owner: Pubkey,
    pub ref_shares_per_cash_e9: u64,
    pub band_bps: u16,
    pub auction_secs: i64,
    pub min_ref_shares_per_cash_e9: u64,
    pub max_ref_shares_per_cash_e9: u64,
}

#[event]
pub struct PlanRun {
    pub plan: Pubkey,
    pub order: Pubkey,
    /// 1-based index of this run.
    pub run: u32,
    pub cash: u64,
    pub start_shares: u64,
    pub end_shares: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub ref_shares_per_cash_e9: u64,
    pub runs_left: u32,
    pub next_run_ts: i64,
}

#[event]
pub struct PlanClosed {
    pub plan: Pubkey,
    pub owner: Pubkey,
    pub runs_done: u32,
    pub runs_left: u32,
    pub revoked: bool,
}

// ------------------------------------------------------------------ helpers

fn is_token_program(key: &Pubkey) -> bool {
    key == &spl_token_2022::ID || key == &anchor_spl::token::ID
}

/// Decode a real, initialised mint (SPL Token or Token-2022). Rejects
/// anything else that merely happens to be long enough, such as a token
/// account, an uninitialised buffer or a multisig.
fn load_mint(info: &AccountInfo) -> Result<SplMint> {
    let data = info.try_borrow_data()?;
    let state =
        StateWithExtensions::<SplMint>::unpack(&data).map_err(|_| SheafError::MalformedMint)?;
    Ok(state.base)
}

/// Token-2022 extension type ids, as numbered on chain. The `spl-token-2022`
/// crate this program builds against predates the last few (ScaledUiAmount,
/// Pausable), so the TLV area is walked by number rather than through it,
/// and anything unrecognised is refused rather than ignored.
mod ext {
    pub const TRANSFER_FEE_CONFIG: u16 = 1;
    pub const CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
    pub const DEFAULT_ACCOUNT_STATE: u16 = 6;
    pub const NON_TRANSFERABLE: u16 = 9;
    pub const PERMANENT_DELEGATE: u16 = 12;
    pub const TRANSFER_HOOK: u16 = 14;
    pub const CONFIDENTIAL_TRANSFER_FEE_CONFIG: u16 = 16;
    pub const METADATA_POINTER: u16 = 18;
    pub const TOKEN_METADATA: u16 = 19;
    pub const GROUP_POINTER: u16 = 20;
    pub const TOKEN_GROUP: u16 = 21;
    pub const GROUP_MEMBER_POINTER: u16 = 22;
    pub const TOKEN_GROUP_MEMBER: u16 = 23;
    pub const SCALED_UI_AMOUNT: u16 = 25;
    pub const PAUSABLE: u16 = 26;
    /// `AccountState::Initialized` / `Frozen`, the value of DefaultAccountState.
    pub const STATE_INITIALIZED: u8 = 1;
    pub const STATE_FROZEN: u8 = 2;
}

/// Call `f(type, value)` for every extension on a mint. A base-only mint
/// (82 bytes, which every legacy SPL Token mint is) has none.
fn for_each_mint_extension(data: &[u8], mut f: impl FnMut(u16, &[u8]) -> Result<()>) -> Result<()> {
    // Token-2022 pads a mint to the token-account length, then stores the
    // account type (1 = Mint) and the TLV entries.
    const BASE_LEN: usize = 82;
    const ACCOUNT_TYPE_AT: usize = 165;
    if data.len() == BASE_LEN {
        return Ok(());
    }
    require!(
        data.len() > ACCOUNT_TYPE_AT && data[ACCOUNT_TYPE_AT] == 1,
        SheafError::MalformedMint
    );
    let mut at = ACCOUNT_TYPE_AT + 1;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        if ty == 0 {
            break; // Uninitialized: the rest is padding.
        }
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        let start = at + 4;
        let end = start.checked_add(len).ok_or(SheafError::MalformedMint)?;
        require!(end <= data.len(), SheafError::MalformedMint);
        f(ty, &data[start..end])?;
        at = end;
    }
    Ok(())
}

/// A share mint may carry metadata and nothing else. Every other extension
/// gives somebody a lever over holders' shares: a permanent delegate moves or
/// burns them, a pause switch blocks redemption, a transfer hook can block
/// transfers, a close authority can re-create the mint, and interest or
/// scaled-amount configs let an authority change what wallets display.
fn check_share_mint_extensions(data: &[u8]) -> Result<()> {
    for_each_mint_extension(data, |ty, _| {
        require!(
            matches!(ty, ext::METADATA_POINTER | ext::TOKEN_METADATA),
            SheafError::ShareMintExtension
        );
        Ok(())
    })
}

/// Whether a 32-byte authority slot (an `OptionalNonZeroPubkey`, all zero
/// meaning "none") is empty or held by a known stock issuer.
fn none_or_known_issuer(slot: &[u8]) -> bool {
    match slot.get(..32) {
        Some(key) => {
            key.iter().all(|b| *b == 0)
                || is_known_issuer(&Pubkey::new_from_array(key.try_into().unwrap()))
        }
        None => false,
    }
}

/// A mint's freeze authority (a `COption<Pubkey>` at bytes 46..82 of the
/// base mint), if it has one.
fn freeze_authority_of(data: &[u8]) -> Result<Option<Pubkey>> {
    require!(data.len() >= 82, SheafError::MalformedMint);
    match u32::from_le_bytes(data[46..50].try_into().unwrap()) {
        0 => Ok(None),
        1 => Ok(Some(Pubkey::new_from_array(data[50..82].try_into().unwrap()))),
        _ => err!(SheafError::MalformedMint),
    }
}

/// What a component may carry.
///
/// Always fine: metadata, group membership, the ScaledUiAmount dividend
/// multiplier (display only), and an "initialised" default account state.
///
/// Issuer powers, accepted only when every authority on them is empty or a
/// known stock issuer (`KNOWN_ISSUERS`), because each one is a lever over the
/// vault: a freeze authority, a permanent delegate (moves vault balances), a
/// pause switch (blocks every redemption), a transfer fee (its authority can
/// raise it until deposits fail or pay double), confidential-transfer
/// configs, and a transfer hook with no program set (whose authority could set
/// one, and a hook's extra accounts are not forwarded, so that would brick the
/// basket).
/// Every real xStock and PreStock carries all of these under its issuer.
///
/// Refused outright, along with anything unrecognised: a transfer hook with a
/// program set, a frozen default state, and non-transferability.
fn check_component_extensions(data: &[u8]) -> Result<()> {
    for_each_mint_extension(data, |ty, value| {
        let ok = match ty {
            ext::METADATA_POINTER
            | ext::TOKEN_METADATA
            | ext::GROUP_POINTER
            | ext::TOKEN_GROUP
            | ext::GROUP_MEMBER_POINTER
            | ext::TOKEN_GROUP_MEMBER
            | ext::SCALED_UI_AMOUNT => true,
            ext::DEFAULT_ACCOUNT_STATE => value.first() == Some(&ext::STATE_INITIALIZED),
            // TransferFeeConfig = { transfer_fee_config_authority,
            // withdraw_withheld_authority, .. }: the first could raise the fee
            // until every deposit overflows or pays it double; the second
            // collects whatever fee is withheld. A creator holding either
            // could skim every deposit past the 1% creator-fee cap, so both
            // must be empty or an issuer.
            ext::TRANSFER_FEE_CONFIG => {
                require!(
                    none_or_known_issuer(value) && value.len() >= 64 && none_or_known_issuer(&value[32..64]),
                    SheafError::ComponentIssuerAuthority
                );
                true
            }
            // PermanentDelegate = { delegate }; PausableConfig = { authority,
            // paused }; ConfidentialTransferMint = { authority, .. };
            // ConfidentialTransferFeeConfig = { authority, .. }.
            ext::PERMANENT_DELEGATE
            | ext::PAUSABLE
            | ext::CONFIDENTIAL_TRANSFER_MINT
            | ext::CONFIDENTIAL_TRANSFER_FEE_CONFIG => {
                require!(none_or_known_issuer(value), SheafError::ComponentIssuerAuthority);
                true
            }
            // TransferHook = { authority, program_id }: no program, and nobody
            // but the issuer able to set one.
            ext::TRANSFER_HOOK => {
                let no_program = value.len() >= 64 && value[32..64].iter().all(|b| *b == 0);
                if no_program {
                    require!(none_or_known_issuer(value), SheafError::ComponentIssuerAuthority);
                }
                no_program
            }
            _ => false,
        };
        require!(ok, SheafError::ComponentMintExtension);
        Ok(())
    })?;
    // A freeze authority can freeze the vault, which blocks every redemption.
    if let Some(freezer) = freeze_authority_of(data)? {
        require!(is_known_issuer(&freezer), SheafError::ComponentIssuerAuthority);
    }
    Ok(())
}

/// A cash mint must not let anyone take escrowed cash back out, pause it, or
/// make it untransferable before the filler is paid. Not checked: the base
/// freeze authority, which is the cash issuer's (Circle holds one on USDC) and
/// can freeze any holder's account, an escrow or a filler's included; that is
/// the issuer trust every holder of that cash already has, and fillers should
/// fill only against cash mints they allowlist. Refused: a
/// permanent delegate, a pause switch, a frozen default account state,
/// non-transferability, a transfer hook with a program set (its accounts are
/// not forwarded, so it would only brick the order), and any extension this
/// program does not recognise. Two more need the right authority, because the
/// authority could change them after an order is placed: a transfer fee (its
/// config authority could raise the fee to 100% and take the filler's
/// payout) and a program-less transfer hook (its authority could set a
/// program). Both are accepted only when that authority is empty or a known
/// issuer. Everything else (metadata, confidential-transfer configs, a close
/// authority, interest or scaled display) cannot touch an escrow and is
/// allowed.
fn check_cash_mint_extensions(data: &[u8]) -> Result<()> {
    for_each_mint_extension(data, |ty, value| {
        let ok = match ty {
            ext::PERMANENT_DELEGATE | ext::PAUSABLE | ext::NON_TRANSFERABLE => false,
            ext::DEFAULT_ACCOUNT_STATE => value.first() != Some(&ext::STATE_FROZEN),
            // TransferHook = { authority, program_id }; a zero program id means none.
            ext::TRANSFER_HOOK => {
                let no_program = value.len() >= 64 && value[32..64].iter().all(|b| *b == 0);
                if no_program {
                    require!(none_or_known_issuer(value), SheafError::CashMintAuthority);
                }
                no_program
            }
            // TransferFeeConfig = { transfer_fee_config_authority, .. }.
            ext::TRANSFER_FEE_CONFIG => {
                require!(none_or_known_issuer(value), SheafError::CashMintAuthority);
                true
            }
            t => t < ext::PAUSABLE,
        };
        require!(ok, SheafError::CashMintExtension);
        Ok(())
    })
}

/// Revoke `plan`'s delegation on the owner's cash account, if it is still
/// the delegate there and the account still belongs to the signing owner.
/// Never fails just because the account has since changed or been closed.
fn revoke_if_delegate<'info>(
    cash_info: AccountInfo<'info>,
    cash_token_program: AccountInfo<'info>,
    plan: &Pubkey,
    owner: AccountInfo<'info>,
) -> Result<bool> {
    let revocable = cash_info.owner == cash_token_program.key && {
        let data = cash_info.try_borrow_data()?;
        match StateWithExtensions::<SplAccount>::unpack(&data) {
            Ok(state) => {
                let delegate: Option<Pubkey> = state.base.delegate.into();
                delegate == Some(*plan) && state.base.owner == *owner.key
            }
            Err(_) => false,
        }
    };
    if revocable {
        token_interface::revoke(CpiContext::new(
            cash_token_program,
            Revoke {
                source: cash_info,
                authority: owner,
            },
        ))?;
    }
    Ok(revocable)
}

/// Take the recipe for `shares` in kind from `depositor` into the basket's
/// vaults. Shared by `mint_shares` and `fill_order`, so a desk fill obeys
/// exactly the same rounding, transfer-fee gross-up and vault checks.
///
/// `remaining` is `[component_mint, depositor_token_account, basket_vault_ata]`
/// per component, in basket order.
fn deposit_components<'info>(
    basket: &Basket,
    basket_key: &Pubkey,
    remaining: &[AccountInfo<'info>],
    component_token_program: &AccountInfo<'info>,
    depositor: &AccountInfo<'info>,
    shares: u64,
) -> Result<[u64; MAX_COMPONENTS]> {
    let count = basket.component_count as usize;
    require!(
        remaining.len() == count * 3,
        SheafError::AccountCountMismatch
    );
    let token_program_key = basket.token_program;
    require!(
        component_token_program.key() == token_program_key,
        SheafError::WrongTokenProgram
    );

    let mut deposited = [0u64; MAX_COMPONENTS];
    let epoch = Clock::get()?.epoch;

    for i in 0..count {
        let component = basket.components[i];
        let mint_info = &remaining[i * 3];
        let from_info = &remaining[i * 3 + 1];
        let vault_info = &remaining[i * 3 + 2];

        require!(
            mint_info.key() == component.mint,
            SheafError::ComponentMintMismatch
        );
        // Re-checked on every deposit, so a basket created before component
        // extensions were vetted cannot take in more value it could lose.
        check_component_extensions(&mint_info.try_borrow_data()?)?;
        // Deposits round up, so rounding dust accrues to the vault.
        let target = mul_div_ceil(component.units_per_share, shares, ONE_SHARE)?;
        require!(target > 0, SheafError::DustMint);
        // Grossed up for any transfer fee, so the vault still nets `target`.
        let amount = gross_for_transfer_fee(mint_info, target, epoch)?;

        verify_vault(vault_info, basket_key, &component.mint, &token_program_key)?;
        verify_token_account(from_info, &component.mint)?;

        token_interface::transfer_checked(
            CpiContext::new(
                component_token_program.clone(),
                TransferChecked {
                    from: from_info.clone(),
                    mint: mint_info.clone(),
                    to: vault_info.clone(),
                    authority: depositor.clone(),
                },
            ),
            amount,
            component.decimals,
        )?;
        deposited[i] = amount;
    }
    Ok(deposited)
}

/// Mint `net_shares` to `to` and `fee_shares` to the creator, signed by the
/// basket PDA. The creator account must really belong to the basket creator.
#[allow(clippy::too_many_arguments)]
fn issue_shares<'info>(
    basket: &Basket,
    basket_info: AccountInfo<'info>,
    share_mint: AccountInfo<'info>,
    share_token_program: AccountInfo<'info>,
    to: AccountInfo<'info>,
    creator_share_account: Option<AccountInfo<'info>>,
    net_shares: u64,
    fee_shares: u64,
) -> Result<()> {
    // Re-checked at every issuance, so a basket whose share mint predates the
    // extension check cannot sell anyone new shares a creator could seize.
    check_share_mint_extensions(&share_mint.try_borrow_data()?)?;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"basket",
        basket.creator.as_ref(),
        basket.symbol.as_bytes(),
        &[basket.bump],
    ]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            share_token_program.clone(),
            MintTo {
                mint: share_mint.clone(),
                to,
                authority: basket_info.clone(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    if fee_shares > 0 {
        let creator_share_account =
            creator_share_account.ok_or(SheafError::MissingCreatorShareAccount)?;
        verify_token_account(&creator_share_account, &share_mint.key())?;
        verify_token_account_owner(&creator_share_account, &basket.creator)?;
        token_interface::mint_to(
            CpiContext::new_with_signer(
                share_token_program,
                MintTo {
                    mint: share_mint,
                    to: creator_share_account,
                    authority: basket_info,
                },
                signer_seeds,
            ),
            fee_shares,
        )?;
    }
    Ok(())
}

/// Move `amount` of cash into an order's escrow and return what the escrow
/// actually received (a Token-2022 transfer fee is withheld at the escrow).
fn fund_escrow<'info>(
    from: AccountInfo<'info>,
    cash_mint: &InterfaceAccount<'info, Mint>,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    cash_token_program: AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    let before = escrow.amount;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            cash_token_program,
            TransferChecked {
                from,
                mint: cash_mint.to_account_info(),
                to: escrow.to_account_info(),
                authority,
            },
            signer_seeds,
        ),
        amount,
        cash_mint.decimals,
    )?;
    escrow.reload()?;
    let received = escrow
        .amount
        .checked_sub(before)
        .ok_or(SheafError::MathOverflow)?;
    require!(received > 0, SheafError::ZeroCash);
    Ok(received)
}

/// Send the escrow's whole balance to `to`, sweep any withheld Token-2022
/// transfer fee to the mint (a token account cannot close while holding
/// one), and close the escrow, rent to `rent_to`. Signed by the order PDA.
#[allow(clippy::too_many_arguments)]
fn drain_and_close_escrow<'info>(
    order: &Order,
    order_key: Pubkey,
    order_info: AccountInfo<'info>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    cash_mint: AccountInfo<'info>,
    cash_decimals: u8,
    to: AccountInfo<'info>,
    rent_to: AccountInfo<'info>,
    cash_token_program: AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<u64> {
    let nonce_bytes = order.nonce.to_le_bytes();
    let bump = [order.bump];
    let plan_key = order.plan.unwrap_or_default();
    // Plan orders live under their plan (`["plan_order", plan, nonce]`); user
    // orders, and plan orders placed before that namespace existed, under
    // `["order", basket, buyer, nonce]`. Sign with whichever derives this order.
    let plan_seeds: &[&[u8]] = &[b"plan_order", plan_key.as_ref(), &nonce_bytes, &bump];
    let user_seeds: &[&[u8]] = &[
        b"order",
        order.basket.as_ref(),
        order.buyer.as_ref(),
        &nonce_bytes,
        &bump,
    ];
    let is_plan_namespace = order.plan.is_some()
        && Pubkey::create_program_address(plan_seeds, &crate::ID)
            .map(|k| k == order_key)
            .unwrap_or(false);
    let seeds = if is_plan_namespace { plan_seeds } else { user_seeds };
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let escrow_info = escrow.to_account_info();

    let amount = escrow.amount;
    if amount > 0 {
        memo_if_required(&to, remaining)?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                cash_token_program.clone(),
                TransferChecked {
                    from: escrow_info.clone(),
                    mint: cash_mint.clone(),
                    to,
                    authority: order_info.clone(),
                },
                signer_seeds,
            ),
            amount,
            cash_decimals,
        )?;
    }

    if cash_token_program.key() == spl_token_2022::ID {
        let withheld = {
            let data = escrow_info.try_borrow_data()?;
            let state = StateWithExtensions::<SplAccount>::unpack(&data)
                .map_err(|_| SheafError::MalformedTokenAccount)?;
            state
                .get_extension::<TransferFeeAmount>()
                .map(|ext| u64::from(ext.withheld_amount))
                .unwrap_or(0)
        };
        if withheld > 0 {
            let ix = spl_token_2022::extension::transfer_fee::instruction::harvest_withheld_tokens_to_mint(
                &spl_token_2022::ID,
                cash_mint.key,
                &[escrow_info.key],
            )?;
            invoke(
                &ix,
                &[cash_mint.clone(), escrow_info.clone(), cash_token_program.clone()],
            )?;
        }
    }

    token_interface::close_account(CpiContext::new_with_signer(
        cash_token_program,
        CloseAccount {
            account: escrow_info,
            destination: rent_to,
            authority: order_info,
        },
        signer_seeds,
    ))?;
    Ok(amount)
}

/// Send a sell order's whole escrow to `to` and close the escrow, rent to
/// `rent_to`. Signed by the sell-order PDA. Returns the shares sent.
#[allow(clippy::too_many_arguments)]
fn release_sell_escrow<'info>(
    order: &SellOrder,
    order_key: Pubkey,
    order_info: AccountInfo<'info>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    share_mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    rent_to: AccountInfo<'info>,
    share_token_program: AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<u64> {
    let nonce_bytes = order.nonce.to_le_bytes();
    let bump = [order.bump];
    let seeds: &[&[u8]] = &[
        b"sell",
        order.basket.as_ref(),
        order.seller.as_ref(),
        &nonce_bytes,
        &bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let _ = order_key;
    let amount = escrow.amount;
    if amount > 0 {
        memo_if_required(&to, remaining)?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                share_token_program.clone(),
                TransferChecked {
                    from: escrow.to_account_info(),
                    mint: share_mint.to_account_info(),
                    to,
                    authority: order_info.clone(),
                },
                signer_seeds,
            ),
            amount,
            SHARE_DECIMALS,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        share_token_program,
        CloseAccount {
            account: escrow.to_account_info(),
            destination: rent_to,
            authority: order_info,
        },
        signer_seeds,
    ))?;
    Ok(amount)
}

fn emit_order_placed(order: &Order, order_key: Pubkey) {
    emit!(OrderPlaced {
        order: order_key,
        basket: order.basket,
        buyer: order.buyer,
        plan: order.plan,
        cash_mint: order.cash_mint,
        nonce: order.nonce,
        cash_amount: order.cash_amount,
        start_shares: order.start_shares,
        end_shares: order.end_shares,
        start_ts: order.start_ts,
        end_ts: order.end_ts,
    });
}

/// An auction must decay (or hold) towards a positive floor, over a real
/// window that has not already closed and closes within `MAX_ORDER_SECS`,
/// so nobody's rent or cash can be parked behind an order for a century.
fn validate_auction(
    start_shares: u64,
    end_shares: u64,
    start_ts: i64,
    end_ts: i64,
    now: i64,
) -> Result<()> {
    require!(
        end_shares > 0 && start_shares >= end_shares,
        SheafError::BadAuctionShares
    );
    require!(
        start_ts < end_ts && end_ts > now && (end_ts as i128 - now as i128) <= MAX_ORDER_SECS as i128,
        SheafError::BadAuctionWindow
    );
    Ok(())
}

/// The owner-settable terms of a plan, as `open_plan` and `update_plan` accept them.
fn validate_plan_terms(
    cash_per_run: u64,
    auction_secs: i64,
    ref_e9: u64,
    band_bps: u16,
    min_ref_e9: u64,
    max_ref_e9: u64,
) -> Result<()> {
    require!(
        auction_secs > 0 && auction_secs <= MAX_ORDER_SECS,
        SheafError::BadPlanSchedule
    );
    require!(ref_e9 > 0, SheafError::BadReferenceRate);
    require!(
        min_ref_e9 > 0 && min_ref_e9 <= ref_e9 && ref_e9 <= max_ref_e9,
        SheafError::BadReferenceBounds
    );
    require!(band_bps <= MAX_BAND_BPS, SheafError::BandTooWide);
    // A run at these terms must already be able to describe an auction.
    let (_, end) = plan_auction(cash_per_run, ref_e9, band_bps, min_ref_e9)?;
    require!(end > 0, SheafError::PlanAmountTooSmall);
    Ok(())
}

/// A plan run's auction: `plan_bounds`, with the end raised to the owner's
/// floor `cash × min_ref / 10^9` (and the start to at least the end).
pub fn plan_auction(cash: u64, ref_e9: u64, band_bps: u16, min_ref_e9: u64) -> Result<(u64, u64)> {
    let (start, end) = plan_bounds(cash, ref_e9, band_bps)?;
    let floor = mul_div_floor(cash, min_ref_e9, RATE_SCALE)?;
    let end = end.max(floor);
    Ok((start.max(end), end))
}

/// Shares the buyer must receive at `now`: `start_shares` up to `start_ts`,
/// `end_shares` from `end_ts`, linear in between. The decay is rounded down,
/// so between the endpoints the buyer gets the rounding (never fewer shares
/// than the exact line).
pub fn required_shares(
    start_shares: u64,
    end_shares: u64,
    start_ts: i64,
    end_ts: i64,
    now: i64,
) -> Result<u64> {
    if now <= start_ts {
        return Ok(start_shares);
    }
    if now >= end_ts {
        return Ok(end_shares);
    }
    let span = start_shares
        .checked_sub(end_shares)
        .ok_or(SheafError::BadAuctionShares)?;
    // Widened to i128 so no choice of timestamps can overflow; here
    // start_ts < now < end_ts, so both are positive and elapsed < duration.
    let elapsed = (now as i128 - start_ts as i128) as u128;
    let duration = (end_ts as i128 - start_ts as i128) as u128;
    let decay = (span as u128)
        .checked_mul(elapsed)
        .ok_or(SheafError::MathOverflow)?
        / duration;
    // decay < span, so it fits and the subtraction cannot underflow.
    Ok(start_shares - decay as u64)
}

/// The creator fee on `shares` alone, floored (a basket with no protocol fee
/// charges exactly this).
pub fn creator_fee_on(shares: u64, fee_bps: u16) -> Result<u64> {
    mul_div_floor(shares, fee_bps as u64, BPS)
}

/// A basket's creator and protocol fee together, in basis points.
pub fn total_fee_bps(basket: &Basket) -> u16 {
    basket.creator_fee_bps.saturating_add(basket.protocol_fee_bps)
}

/// The (creator, protocol) fee shares on `shares` created.
///
/// One rounding for the pair: together they take `floor(shares × (c + p) /
/// 10^4)`, so the depositor's net is monotone in `shares` and
/// `gross_shares_for_net` stays exact. The protocol takes
/// `floor(shares × p / 10^4)` of that, and the creator the rest, which is
/// never less than its own `floor(shares × c / 10^4)` and at most one raw unit
/// more. With `p = 0` this is exactly the creator fee alone.
pub fn fee_split(shares: u64, creator_bps: u16, protocol_bps: u16) -> Result<(u64, u64)> {
    let total = mul_div_floor(shares, creator_bps as u64 + protocol_bps as u64, BPS)?;
    let protocol = mul_div_floor(shares, protocol_bps as u64, BPS)?;
    Ok((total - protocol, protocol))
}

/// Record protocol-fee shares created by one issuance.
fn accrue_protocol_fee(basket: &mut Basket, basket_key: Pubkey, shares: u64) -> Result<()> {
    if shares == 0 {
        return Ok(());
    }
    basket.protocol_fee_accrued = basket
        .protocol_fee_accrued
        .checked_add(shares)
        .ok_or(SheafError::MathOverflow)?;
    emit!(ProtocolFeeAccrued {
        basket: basket_key,
        shares,
        accrued: basket.protocol_fee_accrued,
    });
    Ok(())
}

/// The smallest gross share count whose fees (`fee_bps` = creator plus
/// protocol, see `fee_split`) leave exactly `net` for the buyer. The net of `g` grows by 0 or 1 per unit of `g`, so the smallest
/// `g` netting at least `net` nets exactly `net`. `ceil(net / (1 - fee))` can
/// overshoot it by at most two units (the fee is floored), so step down.
pub fn gross_shares_for_net(net: u64, fee_bps: u16) -> Result<u64> {
    require!(fee_bps < BPS as u16, SheafError::MathOverflow);
    let net_of = |g: u64| -> Result<u64> {
        g.checked_sub(creator_fee_on(g, fee_bps)?)
            .ok_or_else(|| SheafError::MathOverflow.into())
    };
    let mut gross = mul_div_ceil(net, BPS, BPS - fee_bps as u64)?;
    for _ in 0..3 {
        if gross > net && net_of(gross - 1)? >= net {
            gross -= 1;
        } else {
            break;
        }
    }
    require!(net_of(gross)? == net, SheafError::MathOverflow);
    Ok(gross)
}

/// A plan's auction for `cash`: `cash × ref × (1 ± band)`, both rounded down.
pub fn plan_bounds(cash: u64, ref_e9: u64, band_bps: u16) -> Result<(u64, u64)> {
    let base = (cash as u128)
        .checked_mul(ref_e9 as u128)
        .ok_or(SheafError::MathOverflow)?;
    let denom = (RATE_SCALE as u128) * (BPS as u128);
    let scale = |mult: u64| -> Result<u64> {
        let v = base
            .checked_mul(mult as u128)
            .ok_or(SheafError::MathOverflow)?
            / denom;
        u64::try_from(v).map_err(|_| SheafError::MathOverflow.into())
    };
    let start = scale(BPS + band_bps as u64)?;
    let end = scale(BPS - band_bps as u64)?;
    Ok((start, end))
}

/// The rate an order filled at, in the plan's fixed point, rounded down.
pub fn shares_per_cash_e9(shares: u64, cash: u64) -> Result<u64> {
    mul_div_floor(shares, RATE_SCALE, cash)
}

/// Raw cash units per whole share, rounded down and saturating: a figure
/// for the event log, which must never be what makes a fill fail.
pub fn price_per_share(cash: u64, shares: u64) -> u64 {
    if shares == 0 {
        return u64::MAX;
    }
    let p = (cash as u128) * (ONE_SHARE as u128) / (shares as u128);
    u64::try_from(p).unwrap_or(u64::MAX)
}

/// A vault must be the canonical associated token account of the basket PDA for
/// that component, so off-chain net-asset-value maths can rely on one address.
fn verify_vault(
    vault: &AccountInfo,
    basket: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[basket.as_ref(), token_program.as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    );
    require!(vault.key() == expected, SheafError::VaultMismatch);
    Ok(())
}

/// Confirm a token account really is for `mint` before moving value through it.
fn verify_token_account(account: &AccountInfo, mint: &Pubkey) -> Result<()> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, SheafError::MalformedTokenAccount);
    let mut k = [0u8; 32];
    k.copy_from_slice(&data[0..32]);
    require!(
        Pubkey::new_from_array(k) == *mint,
        SheafError::TokenAccountMintMismatch
    );
    Ok(())
}

/// Confirm a token account is owned by `owner` (same offset in both programs).
fn verify_token_account_owner(account: &AccountInfo, owner: &Pubkey) -> Result<()> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, SheafError::MalformedTokenAccount);
    let mut k = [0u8; 32];
    k.copy_from_slice(&data[32..64]);
    require!(
        Pubkey::new_from_array(k) == *owner,
        SheafError::CreatorShareAccountOwner
    );
    Ok(())
}

/// The raw amount to send so that, after any Token-2022 transfer fee, the
/// recipient nets exactly `target`. Mints without `TransferFeeConfig` (every
/// xStock, and legacy SPL Token mints) pass through unchanged.
///
/// The TLV area is walked by number (see `ext`): the `spl-token-2022` crate
/// this builds against stops at the first extension type it does not know
/// (Pausable, ScaledUiAmount), so asking it would silently skip the fee on a
/// mint that lists one of those before its `TransferFeeConfig`.
fn gross_for_transfer_fee(mint_info: &AccountInfo, target: u64, epoch: u64) -> Result<u64> {
    let data = mint_info.try_borrow_data()?;
    let mut gross = target;
    for_each_mint_extension(&data, |ty, value| {
        if ty == ext::TRANSFER_FEE_CONFIG {
            gross = pre_fee_amount(value, target, epoch)?;
        }
        Ok(())
    })?;
    Ok(gross)
}

/// `TransferFeeConfig` = { config authority (32), withdraw authority (32),
/// withheld (8), older fee (18), newer fee (18) }, each fee being
/// { epoch u64, maximum_fee u64, basis_points u16 }. From its epoch on, the
/// newer fee is in force, exactly as the token program picks it.
fn pre_fee_amount(value: &[u8], target: u64, epoch: u64) -> Result<u64> {
    require!(value.len() >= 108, SheafError::MalformedMint);
    let u64_at = |o: usize| u64::from_le_bytes(value[o..o + 8].try_into().unwrap());
    let u16_at = |o: usize| u16::from_le_bytes(value[o..o + 2].try_into().unwrap());
    let fee_at = |o: usize| TransferFee {
        epoch: u64_at(o).into(),
        maximum_fee: u64_at(o + 8).into(),
        transfer_fee_basis_points: u16_at(o + 16).into(),
    };
    let (older, newer) = (fee_at(72), fee_at(90));
    let fee = if epoch >= u64::from(newer.epoch) { newer } else { older };
    fee.calculate_pre_fee_amount(target)
        .ok_or_else(|| SheafError::MathOverflow.into())
}

fn mul_div_floor(a: u64, b: u64, d: u64) -> Result<u64> {
    let n = (a as u128)
        .checked_mul(b as u128)
        .ok_or(SheafError::MathOverflow)?;
    let q = n
        .checked_div(d as u128)
        .ok_or(SheafError::MathOverflow)?;
    u64::try_from(q).map_err(|_| SheafError::MathOverflow.into())
}

fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64> {
    let n = (a as u128)
        .checked_mul(b as u128)
        .ok_or(SheafError::MathOverflow)?;
    let q = n
        .checked_add((d as u128).checked_sub(1).ok_or(SheafError::MathOverflow)?)
        .ok_or(SheafError::MathOverflow)?
        .checked_div(d as u128)
        .ok_or(SheafError::MathOverflow)?;
    u64::try_from(q).map_err(|_| SheafError::MathOverflow.into())
}

#[error_code]
pub enum SheafError {
    #[msg("Basket name must be 1 to 32 characters")]
    NameTooLong,
    #[msg("Basket symbol must be 1 to 10 characters")]
    SymbolTooLong,
    #[msg("Creator fee cannot exceed 1%")]
    CreatorFeeTooHigh,
    #[msg("A basket holds between 1 and 8 components")]
    BadComponentCount,
    #[msg("Component weights must add up to 100%")]
    WeightsMustSumToOne,
    #[msg("The same component was listed twice")]
    DuplicateComponent,
    #[msg("Every component needs a non-zero weight")]
    ZeroWeight,
    #[msg("Every component needs a non-zero unit amount")]
    ZeroUnits,
    #[msg("Share mint must have 6 decimals")]
    ShareMintDecimals,
    #[msg("Share mint already has a supply")]
    ShareMintNotEmpty,
    #[msg("Share mint authority must be the basket")]
    ShareMintAuthority,
    #[msg("Share mint must not have a freeze authority")]
    ShareMintFreezable,
    #[msg("Share mint does not match the basket")]
    ShareMintMismatch,
    #[msg("Component lives on a different token program")]
    WrongTokenProgram,
    #[msg("Component mint does not match the basket recipe")]
    ComponentMintMismatch,
    #[msg("Wrong number of accounts for this basket")]
    AccountCountMismatch,
    #[msg("Vault is not the basket's associated token account")]
    VaultMismatch,
    #[msg("Token account belongs to a different mint")]
    TokenAccountMintMismatch,
    #[msg("Mint account data is malformed")]
    MalformedMint,
    #[msg("Token account data is malformed")]
    MalformedTokenAccount,
    #[msg("Creator share account is required when a creator fee is set")]
    MissingCreatorShareAccount,
    #[msg("Share amount must be greater than zero")]
    ZeroShares,
    #[msg("Share amount is too small to deposit against")]
    DustMint,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Creator fee shares must go to an account the basket creator owns")]
    CreatorShareAccountOwner,
    #[msg("Cash amount must be greater than zero")]
    ZeroCash,
    #[msg("Auction shares must satisfy start >= end > 0")]
    BadAuctionShares,
    #[msg("Auction window must satisfy start_ts < end_ts and end in the future")]
    BadAuctionWindow,
    #[msg("The auction has ended; the order can only be cancelled")]
    OrderExpired,
    #[msg("Only the buyer can cancel before the auction ends")]
    OrderNotExpired,
    #[msg("Account does not match the order")]
    OrderAccountMismatch,
    #[msg("This order came from a plan; pass the plan account")]
    MissingPlanAccount,
    #[msg("Plan account does not match the order")]
    PlanMismatch,
    #[msg("Account does not match the plan")]
    PlanAccountMismatch,
    #[msg("Plan needs a positive period, run count and auction length")]
    BadPlanSchedule,
    #[msg("Reference rate must be greater than zero")]
    BadReferenceRate,
    #[msg("Plan band cannot exceed 50%")]
    BandTooWide,
    #[msg("Cash per run is too small to buy a raw share unit at this rate")]
    PlanAmountTooSmall,
    #[msg("The next run of this plan is not due yet")]
    PlanTooEarly,
    #[msg("This plan has no runs left")]
    PlanExhausted,
    #[msg("Cash account already delegates a live allowance to someone else")]
    DelegateInUse,
    #[msg("Share mint must be owned by the SPL Token or Token-2022 program")]
    ShareMintProgram,
    #[msg("Share mint may carry metadata and no other extension")]
    ShareMintExtension,
    #[msg("Component mint carries an extension that could drain, pause or brick the vault")]
    ComponentMintExtension,
    #[msg("Cash mint carries an extension that could seize, freeze or block escrowed cash")]
    CashMintExtension,
    #[msg("Escrow holds less than the order's cash")]
    EscrowShort,
    #[msg("Plan rate bounds must satisfy 0 < min <= reference <= max")]
    BadReferenceBounds,
    #[msg("Not a pre-hardening plan account")]
    NotLegacyPlan,
    #[msg("Component mint gives a freeze, seize, pause or hook power to someone other than a known stock issuer")]
    ComponentIssuerAuthority,
    #[msg("Cash mint lets someone other than a known issuer change its transfer fee or transfer hook")]
    CashMintAuthority,
    #[msg("Share mint must be a Token-2022 mint")]
    ShareMintNotToken2022,
    #[msg("This basket has no protocol fee to claim")]
    NothingToClaim,
    #[msg("Protocol fees go only to the treasury")]
    TreasuryMismatch,
    #[msg("A third party's refund must go to the buyer's associated cash account")]
    RefundNotToBuyerAta,
    #[msg("A third party's return must go to the seller's associated share account")]
    RefundNotToSellerAta,
    #[msg("The seller would receive less cash than the auction asks")]
    SellerPaidShort,
    #[msg("The auction starts more than 60 seconds before it was placed")]
    StaleAuctionStart,
    #[msg("A plan's trailing step can be at most 50%")]
    BadTrailStep,
    #[msg("The recipient requires a memo: pass the Memo program as a remaining account")]
    MemoProgramRequired,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auction_endpoints_and_clamping() {
        let (s, e, t0, t1) = (2_000_000u64, 1_000_000u64, 1_000i64, 1_100i64);
        assert_eq!(required_shares(s, e, t0, t1, 0).unwrap(), s);
        assert_eq!(required_shares(s, e, t0, t1, t0).unwrap(), s);
        assert_eq!(required_shares(s, e, t0, t1, t1).unwrap(), e);
        assert_eq!(required_shares(s, e, t0, t1, t1 + 1_000).unwrap(), e);
        assert_eq!(required_shares(s, e, t0, t1, 1_050).unwrap(), 1_500_000);
        assert_eq!(required_shares(s, e, t0, t1, 1_025).unwrap(), 1_750_000);
    }

    #[test]
    fn auction_decay_rounds_in_the_buyers_favour() {
        // 10 shares of span over 3 seconds: at 1s the exact line is 6.666..,
        // the buyer must get 7 (decay 3.33 floored to 3).
        assert_eq!(required_shares(10, 0, 0, 3, 1).unwrap(), 7);
        assert_eq!(required_shares(10, 0, 0, 3, 2).unwrap(), 4);
        // No choice of timestamps can overflow the arithmetic.
        let mid = required_shares(u64::MAX, 1, i64::MIN, i64::MAX, 0).unwrap();
        assert!(mid > 1 && mid < u64::MAX);
        assert_eq!(price_per_share(u64::MAX, 1), u64::MAX);
        assert_eq!(price_per_share(250_000_000, 2_000_000), 125_000_000);
        // Monotone non-increasing across the whole window.
        let mut last = u64::MAX;
        for t in -5..=105 {
            let r = required_shares(987_654, 123_457, 0, 100, t).unwrap();
            assert!(r <= last && r >= 123_457 && r <= 987_654);
            last = r;
        }
    }

    #[test]
    fn gross_up_nets_exactly_and_is_minimal() {
        for fee in [0u16, 1, 7, 30, 99, 100] {
            for net in (1u64..20_000).chain([999_999, 1_000_000, 2_500_001, u64::MAX / 20_000]) {
                let g = gross_shares_for_net(net, fee).unwrap();
                assert_eq!(g - creator_fee_on(g, fee).unwrap(), net, "fee {fee} net {net}");
                if g > net {
                    let below = g - 1;
                    assert!(below - creator_fee_on(below, fee).unwrap() < net);
                }
            }
        }
    }

    #[test]
    fn plan_band_brackets_the_reference() {
        // 100 USDC at 0.004 raw shares per raw cash unit, ±3%.
        let (s, e) = plan_bounds(100_000_000, 4_000_000, 300).unwrap();
        assert_eq!((s, e), (412_000, 388_000));
        let (s, e) = plan_bounds(100_000_000, 4_000_000, 0).unwrap();
        assert_eq!(s, e);
        assert_eq!(shares_per_cash_e9(400_000, 100_000_000).unwrap(), 4_000_000);
        assert!(plan_bounds(u64::MAX, u64::MAX, 300).is_err());
    }

    #[test]
    fn plan_floor_bounds_the_auction() {
        // ±30% around 0.004 would end at 280,000; a 0.0036 floor lifts it.
        assert_eq!(
            plan_auction(100_000_000, 4_000_000, 3_000, 3_600_000).unwrap(),
            (520_000, 360_000)
        );
        // A floor below the band changes nothing.
        assert_eq!(
            plan_auction(100_000_000, 4_000_000, 300, 1).unwrap(),
            (412_000, 388_000)
        );
        // Every ratchet step lands on or above the floor, so n runs of
        // end-of-auction fills cannot walk the rate under it.
        let (mut r, floor) = (4_000_000u64, 3_000_000u64);
        for _ in 0..50 {
            let (_, e) = plan_auction(100_000_000, r, 5_000, floor).unwrap();
            r = shares_per_cash_e9(e, 100_000_000).unwrap().max(floor);
            assert!(r >= floor);
        }
        assert_eq!(r, floor);
    }

    /// Build a Token-2022 mint image carrying the given TLV entries.
    fn mint_with(exts: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut d = vec![0u8; 166];
        d[45] = 1; // is_initialized
        d[165] = 1; // AccountType::Mint
        for (ty, v) in exts {
            d.extend_from_slice(&ty.to_le_bytes());
            d.extend_from_slice(&(v.len() as u16).to_le_bytes());
            d.extend_from_slice(v);
        }
        d
    }

    /// The program error code (offset removed) a check failed with, if any.
    fn failure(r: Result<()>) -> Option<u32> {
        match r {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => {
                Some(e.error_code_number - anchor_lang::error::ERROR_CODE_OFFSET)
            }
            Err(other) => panic!("unexpected error {other:?}"),
        }
    }

    fn code(e: SheafError) -> Option<u32> {
        Some(e as u32)
    }

    /// A value whose leading 32-byte authority slot is `who`, padded to `len`.
    fn authority_ext(ty: u16, who: &Pubkey, len: usize) -> (u16, Vec<u8>) {
        let mut v = vec![0u8; len];
        v[..32].copy_from_slice(who.as_ref());
        (ty, v)
    }

    /// Set a mint image's freeze authority.
    fn with_freezer(mut d: Vec<u8>, who: &Pubkey) -> Vec<u8> {
        d[46] = 1;
        d[50..82].copy_from_slice(who.as_ref());
        d
    }

    #[test]
    fn extension_policies() {
        let none = Pubkey::default();
        let issuer = BACKED_ISSUER;
        let creator = Pubkey::new_from_array([7u8; 32]);

        let meta = (ext::METADATA_POINTER, vec![0u8; 64]);
        let scaled = (ext::SCALED_UI_AMOUNT, vec![0u8; 56]);
        let fee = (ext::TRANSFER_FEE_CONFIG, vec![0u8; 108]);
        let frozen = (ext::DEFAULT_ACCOUNT_STATE, vec![ext::STATE_FROZEN]);
        let open = (ext::DEFAULT_ACCOUNT_STATE, vec![ext::STATE_INITIALIZED]);
        let non_transferable = (ext::NON_TRANSFERABLE, vec![]);
        let close_authority = authority_ext(3, &creator, 32);
        let mut live_hook = authority_ext(ext::TRANSFER_HOOK, &issuer, 64);
        live_hook.1[40] = 7;
        let unknown = (99u16, vec![]);
        // The issuer powers, each under nobody, a known issuer, and a stranger.
        let powers = |who: &Pubkey| {
            [
                authority_ext(ext::PERMANENT_DELEGATE, who, 32),
                authority_ext(ext::PAUSABLE, who, 33),
                authority_ext(ext::CONFIDENTIAL_TRANSFER_MINT, who, 65),
                authority_ext(ext::CONFIDENTIAL_TRANSFER_FEE_CONFIG, who, 129),
                authority_ext(ext::TRANSFER_HOOK, who, 64),
            ]
        };

        // Share mints: metadata and nothing else, whoever holds the power.
        assert!(check_share_mint_extensions(&vec![0u8; 82]).is_ok());
        assert!(check_share_mint_extensions(&mint_with(&[meta.clone()])).is_ok());
        for bad in [scaled.clone(), fee.clone(), unknown.clone()]
            .into_iter()
            .chain(powers(&none))
            .chain(powers(&issuer))
        {
            assert_eq!(
                failure(check_share_mint_extensions(&mint_with(&[meta.clone(), bad]))),
                code(SheafError::ShareMintExtension)
            );
        }

        // Components: what xStocks and PreStocks carry, with every power under
        // their issuer (or nobody), is accepted. The same powers under anyone
        // else are not.
        let mut real = vec![meta.clone(), scaled.clone(), fee.clone(), open.clone()];
        real.extend(powers(&issuer));
        assert_eq!(failure(check_component_extensions(&with_freezer(mint_with(&real), &BACKED_PAUSER))), None);
        let mut prestock = vec![meta.clone(), fee.clone(), open.clone()];
        prestock.extend(powers(&PRESTOCKS_ISSUER));
        assert_eq!(failure(check_component_extensions(&with_freezer(mint_with(&prestock), &PRESTOCKS_ISSUER))), None);
        for p in powers(&none) {
            assert_eq!(failure(check_component_extensions(&mint_with(&[p]))), None);
        }
        for p in powers(&creator) {
            assert_eq!(
                failure(check_component_extensions(&mint_with(&[p]))),
                code(SheafError::ComponentIssuerAuthority)
            );
        }
        assert_eq!(
            failure(check_component_extensions(&with_freezer(mint_with(&[open.clone()]), &creator))),
            code(SheafError::ComponentIssuerAuthority),
            "a freeze authority is an issuer power too"
        );
        assert_eq!(
            failure(check_component_extensions(&with_freezer(mint_with(&[]), &STAND_IN_ISSUER))),
            if cfg!(feature = "devnet") { None } else { code(SheafError::ComponentIssuerAuthority) },
            "the write cluster's stand-in issuer is known only in a devnet build"
        );
        // A transfer fee is an issuer power too: under the creator it is refused.
        assert_eq!(
            failure(check_component_extensions(&mint_with(&[authority_ext(ext::TRANSFER_FEE_CONFIG, &creator, 108)]))),
            code(SheafError::ComponentIssuerAuthority)
        );
        for bad in [frozen.clone(), live_hook.clone(), non_transferable.clone(), close_authority.clone(), unknown.clone()] {
            assert_eq!(
                failure(check_component_extensions(&mint_with(&[bad]))),
                code(SheafError::ComponentMintExtension)
            );
        }

        // Cash: a transfer fee or program-less hook only under nobody or an
        // issuer, since its authority could change it after an order is placed.
        let null_hook = (ext::TRANSFER_HOOK, vec![0u8; 64]);
        assert!(check_cash_mint_extensions(&mint_with(&[meta.clone(), fee.clone(), null_hook.clone(), open.clone()])).is_ok());
        let issuer_fee = authority_ext(ext::TRANSFER_FEE_CONFIG, &PRESTOCKS_ISSUER, 108);
        let issuer_hook = authority_ext(ext::TRANSFER_HOOK, &issuer, 64);
        assert!(check_cash_mint_extensions(&mint_with(&[issuer_fee, issuer_hook])).is_ok());
        for bad in [
            authority_ext(ext::TRANSFER_FEE_CONFIG, &creator, 108),
            authority_ext(ext::TRANSFER_HOOK, &creator, 64),
        ] {
            assert_eq!(failure(check_cash_mint_extensions(&mint_with(&[bad]))), code(SheafError::CashMintAuthority));
        }
        for bad in [
            authority_ext(ext::PERMANENT_DELEGATE, &issuer, 32),
            authority_ext(ext::PAUSABLE, &issuer, 33),
            frozen,
            live_hook,
            non_transferable,
            unknown,
        ] {
            assert_eq!(failure(check_cash_mint_extensions(&mint_with(&[bad]))), code(SheafError::CashMintExtension));
        }

        // Malformed TLV (length running past the end) is refused, not skipped.
        let mut broken = mint_with(&[meta]);
        broken.extend_from_slice(&ext::TOKEN_METADATA.to_le_bytes());
        broken.extend_from_slice(&500u16.to_le_bytes());
        assert!(check_share_mint_extensions(&broken).is_err());
    }

    #[test]
    fn known_issuers_are_the_live_mainnet_keys() {
        assert_eq!(BACKED_ISSUER.to_string(), "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq");
        assert_eq!(BACKED_PAUSER.to_string(), "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs");
        assert_eq!(PRESTOCKS_ISSUER.to_string(), "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
        assert!(KNOWN_ISSUERS.iter().all(is_known_issuer));
        assert!(!is_known_issuer(&Pubkey::default()));
        // The default build is mainnet-safe: no server key is an issuer.
        assert_eq!(is_known_issuer(&STAND_IN_ISSUER), cfg!(feature = "devnet"));
        assert_eq!(is_known_issuer(&STAND_IN_FEE_AUTHORITY), cfg!(feature = "devnet"));
        assert_eq!(TREASURY.to_string(), "9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");
    }

    #[test]
    fn transfer_fee_gross_up_follows_the_epoch_schedule() {
        // A live PreStocks schedule: 3% until epoch 1050, then 1%, uncapped.
        let mut v = vec![0u8; 108];
        let put = |v: &mut Vec<u8>, at: usize, epoch: u64, bps: u16| {
            v[at..at + 8].copy_from_slice(&epoch.to_le_bytes());
            v[at + 8..at + 16].copy_from_slice(&u64::MAX.to_le_bytes());
            v[at + 16..at + 18].copy_from_slice(&bps.to_le_bytes());
        };
        put(&mut v, 72, 1043, 300);
        put(&mut v, 90, 1050, 100);
        let net = |gross: u64, bps: u64| gross - (gross * bps).div_ceil(10_000);
        let g = pre_fee_amount(&v, 1_000_000_000, 0).unwrap();
        assert_eq!(net(g, 300), 1_000_000_000);
        let g = pre_fee_amount(&v, 1_000_000_000, 1050).unwrap();
        assert_eq!(net(g, 100), 1_000_000_000);
        assert!(pre_fee_amount(&v[..100], 1, 0).is_err());
    }

    #[test]
    fn protocol_fee_split_and_gross_up() {
        // No protocol fee: exactly the creator fee alone, as before.
        for shares in [0u64, 1, 333, 334, 999_999, 1_000_000, 123_456_789] {
            assert_eq!(fee_split(shares, 30, 0).unwrap(), (creator_fee_on(shares, 30).unwrap(), 0));
        }
        // 1 share at 0.25% + 0.10%: 2,500 to the creator, 1,000 to the protocol.
        assert_eq!(fee_split(1_000_000, 25, 10).unwrap(), (2_500, 1_000));
        // Rounding: below 1,000 raw units the protocol takes nothing; the pair
        // is floored once and the creator never gets less than its own floor.
        assert_eq!(fee_split(999, 0, 10).unwrap(), (0, 0));
        assert_eq!(fee_split(1_000, 0, 10).unwrap(), (0, 1));
        for g in 0u64..50_000 {
            for (c, p) in [(0u16, 10u16), (25, 10), (30, 10), (100, 10), (7, 3)] {
                let (cf, pf) = fee_split(g, c, p).unwrap();
                assert_eq!(cf + pf, g * (c as u64 + p as u64) / 10_000);
                assert_eq!(pf, g * p as u64 / 10_000);
                assert!(cf >= g * c as u64 / 10_000 && cf <= g * c as u64 / 10_000 + 1);
            }
        }
        // A desk fill delivers the smallest gross whose two fees leave the
        // buyer exactly `net`.
        for (c, p) in [(0u16, 10u16), (25, 10), (100, 10)] {
            for net in (1u64..20_000).chain([999_999, 1_000_000, 2_500_001]) {
                let g = gross_shares_for_net(net, c + p).unwrap();
                let (cf, pf) = fee_split(g, c, p).unwrap();
                assert_eq!(g - cf - pf, net);
                if g > net {
                    let (cf, pf) = fee_split(g - 1, c, p).unwrap();
                    assert!(g - 1 - cf - pf < net);
                }
            }
        }
    }

    #[test]
    fn basket_fee_fields_fit_the_headroom_and_read_zero_on_old_baskets() {
        let mut b = Basket {
            creator: Pubkey::new_unique(),
            share_mint: Pubkey::new_unique(),
            token_program: spl_token_2022::ID,
            name: "x".repeat(MAX_NAME_LEN),
            symbol: "y".repeat(MAX_SYMBOL_LEN),
            creator_fee_bps: 100,
            component_count: 8,
            components: Default::default(),
            created_at: 1,
            mint_count: 2,
            redeem_count: 3,
            bump: 254,
            protocol_fee_bps: PROTOCOL_FEE_BPS,
            protocol_fee_accrued: u64::MAX,
        };
        let mut buf = Vec::new();
        b.try_serialize(&mut buf).unwrap();
        assert!(buf.len() <= Basket::SPACE, "the longest basket still fits its account");
        // An old basket: the same bytes up to `bump`, then the zeroed tail.
        b.protocol_fee_bps = 0;
        b.protocol_fee_accrued = 0;
        let mut old = Vec::new();
        b.try_serialize(&mut old).unwrap();
        let mut account = old[..old.len() - 10].to_vec();
        account.resize(Basket::SPACE, 0);
        let read = Basket::try_deserialize(&mut &account[..]).unwrap();
        assert_eq!((read.protocol_fee_bps, read.protocol_fee_accrued), (0, 0));
        assert_eq!(read.bump, 254);
    }

    fn plan_at(r: u64, min: u64, max: u64) -> Plan {
        Plan {
            owner: Pubkey::default(),
            basket: Pubkey::default(),
            cash_mint: Pubkey::default(),
            cash_token_program: Pubkey::default(),
            cash_account: Pubkey::default(),
            plan_id: 0,
            cash_per_run: 100_000_000,
            period_secs: 60,
            runs_total: 10,
            runs_left: 10,
            next_run_ts: 0,
            ref_shares_per_cash_e9: r,
            band_bps: 200,
            auction_secs: 60,
            last_order: None,
            fills: 0,
            last_fill_ts: 0,
            created_at: 0,
            bump: 0,
            min_ref_shares_per_cash_e9: min,
            max_ref_shares_per_cash_e9: max,
        }
    }

    #[test]
    fn trailing_bounds_follow_fills_and_fixed_bounds_do_not() {
        // A plan opened at 0.004 with ±6% bounds.
        let (r, lo, hi) = (4_000_000u64, 3_760_000u64, 4_240_000u64);

        // Fixed (an old plan, step 0): a market falling 2% a run halts at the floor.
        let mut fixed = plan_at(r, lo, hi);
        for _ in 0..10 {
            let next = fixed.ref_shares_per_cash_e9 * 102 / 100; // shares per cash rise as the price falls
            apply_plan_fill(&mut fixed, next, 0, None).unwrap();
        }
        assert_eq!(fixed.ref_shares_per_cash_e9, hi, "pinned at the owner's ceiling");
        assert_eq!((fixed.min_ref_shares_per_cash_e9, fixed.max_ref_shares_per_cash_e9), (lo, hi));

        // Trailing: the same market is followed, and the bounds move with it.
        let mut trail = plan_at(r, lo, hi);
        let mut expect = r;
        for _ in 0..10 {
            let next = trail.ref_shares_per_cash_e9 * 102 / 100;
            expect = next;
            apply_plan_fill(&mut trail, next, PLAN_STEP_BPS, None).unwrap();
            let rr = trail.ref_shares_per_cash_e9;
            assert_eq!(trail.min_ref_shares_per_cash_e9, rr * 9_400 / 10_000);
            assert_eq!(trail.max_ref_shares_per_cash_e9, rr * 10_600 / 10_000);
        }
        assert_eq!(trail.ref_shares_per_cash_e9, expect);
        assert!(trail.ref_shares_per_cash_e9 > hi, "past the opening ceiling");

        // No single fill moves a trailing plan more than the step.
        let mut jump = plan_at(r, r * 9_400 / 10_000, r * 10_600 / 10_000);
        apply_plan_fill(&mut jump, r * 2, PLAN_STEP_BPS, None).unwrap();
        assert_eq!(jump.ref_shares_per_cash_e9, r * 10_600 / 10_000);
        apply_plan_fill(&mut jump, 1, PLAN_STEP_BPS, None).unwrap();
        assert_eq!(jump.ref_shares_per_cash_e9, (r * 10_600 / 10_000) * 9_400 / 10_000);
    }

    /// Twelve runs of a trailing plan (step 6%, band 2%) against a market
    /// (`market(run)` = raw shares per raw cash unit, x 10^9, that the market
    /// pays). A run fills only if the market can cover the auction's floor;
    /// a monopolist then fills at the floor (the worst count for the owner),
    /// a competitive filler at the market, capped at the auction's start.
    /// Returns every run's reference after the fill and its auction floor.
    fn twelve_runs(market: impl Fn(usize) -> u64, hard: (u64, u64), monopolist: bool) -> Vec<(u64, u64)> {
        let cash = 100_000_000u64;
        let (r, band) = (4_000_000u64, 200u16);
        let mut plan = plan_at(r, hard.0, hard.1);
        plan.band_bps = band;
        let mut out = Vec::new();
        for run in 0..12 {
            let (start, end) = plan_auction(cash, plan.ref_shares_per_cash_e9, band, plan.min_ref_shares_per_cash_e9).unwrap();
            let fair = mul_div_floor(cash, market(run), RATE_SCALE).unwrap();
            if fair >= end {
                let filled = if monopolist { end } else { fair.min(start) };
                let rate = shares_per_cash_e9(filled, cash).unwrap();
                apply_plan_fill(&mut plan, rate, PLAN_STEP_BPS, Some(hard)).unwrap();
            }
            out.push((plan.ref_shares_per_cash_e9, end));
        }
        out
    }

    #[test]
    fn trailing_plans_never_walk_past_the_owner_hard_limits() {
        let cash = 100_000_000u64;
        // The owner's hard limits: never fewer than 0.0035 shares per raw cash
        // unit (a 12.5% worse price than at open), never more than 0.0050.
        let hard = (3_500_000u64, 5_000_000u64);
        let floor_shares = mul_div_floor(cash, hard.0, RATE_SCALE).unwrap();
        let flat = |_: usize| 4_000_000u64;
        // A rising price buys fewer shares per dollar each run; a falling one more.
        let rising = |run: usize| 4_000_000u64 - 100_000 * run as u64;
        let falling = |run: usize| 4_000_000u64 + 150_000 * run as u64;
        for monopolist in [true, false] {
            for (name, runs) in [
                ("flat", twelve_runs(flat, hard, monopolist)),
                ("rising", twelve_runs(rising, hard, monopolist)),
                ("falling", twelve_runs(falling, hard, monopolist)),
            ] {
                for (i, (rf, end)) in runs.iter().enumerate() {
                    assert!(*rf >= hard.0 && *rf <= hard.1, "{name} run {i}: ref {rf} left the hard limits");
                    assert!(*end >= floor_shares, "{name} run {i}: auction floor {end} below the owner's");
                }
                for w in runs.windows(2) {
                    assert!(w[1].0 <= w[0].0 * 10_600 / 10_000 + 1 && w[1].0 * 10_600 / 10_000 + 1 >= w[0].0, "{name}: one run moved more than the step");
                }
            }
        }
        // A monopolist walks even a flat market down 2% a run, and the owner's
        // floor stops it there: pinned at the floor, never below.
        let walked = twelve_runs(flat, hard, true);
        assert!(walked[0].0 < 4_000_000);
        assert_eq!(walked[11].0, hard.0);
        // With competition a flat market stays put, and a falling price is
        // followed up until the owner's ceiling.
        assert!(twelve_runs(flat, hard, false).iter().all(|(rf, _)| *rf == 4_000_000));
        let up = twelve_runs(falling, hard, false);
        assert!(up[5].0 > up[0].0 && up[11].0 > up[5].0);
        // Under a tighter ceiling the same market is followed up to it, and stops.
        let capped = twelve_runs(falling, (hard.0, 4_500_000), false);
        assert_eq!(capped[11].0, 4_500_000);
    }

    #[test]
    fn stale_starts_and_memo_detection() {
        assert!(require_fresh_start(1_000, 1_060).is_ok());
        assert!(require_fresh_start(1_000, 1_061).is_err());
        assert!(require_fresh_start(2_000, 1_000).is_ok(), "a future start is fine");
        // A Token-2022 account image with MemoTransfer (type 8) on, then off.
        let mut acct = vec![0u8; 166];
        acct[165] = 2;
        acct.extend_from_slice(&8u16.to_le_bytes());
        acct.extend_from_slice(&1u16.to_le_bytes());
        acct.push(1);
        assert!(requires_incoming_memo(&acct));
        *acct.last_mut().unwrap() = 0;
        assert!(!requires_incoming_memo(&acct));
        assert!(!requires_incoming_memo(&vec![0u8; 165]), "a legacy account has no extensions");
    }

    #[test]
    fn plan_tail_reads_zero_on_old_plans() {
        assert_eq!(plan_trail_step(&vec![0u8; 8 + Plan::INIT_SPACE]), 0, "a 296-byte plan has no tail");
        let mut new = vec![0u8; PLAN_TAIL_AT + PLAN_TAIL_LEN];
        write_plan_tail(&mut new, PLAN_STEP_BPS, 7, 9);
        assert_eq!(plan_trail_step(&new), PLAN_STEP_BPS);
        assert_eq!(plan_hard_limits(&new), Some((7, 9)));
        // A plan from the first trailing release: an 8-byte tail, no hard limits.
        assert_eq!(plan_hard_limits(&new[..PLAN_TAIL_AT + 8]), None);
        assert_eq!(plan_trail_step(&new[..PLAN_TAIL_AT + 8]), PLAN_STEP_BPS);
        // The struct still decodes from the longer account.
        let mut buf = Vec::new();
        plan_at(1, 1, 1).try_serialize(&mut buf).unwrap();
        buf.resize(PLAN_TAIL_AT + PLAN_TAIL_LEN, 0);
        assert!(Plan::try_deserialize(&mut &buf[..]).is_ok());
    }

    #[test]
    fn plan_layout_grew_by_exactly_the_two_bounds() {
        assert_eq!(8 + Plan::INIT_SPACE, LEGACY_PLAN_LEN + 16);
    }
}
