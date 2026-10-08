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
    transfer_fee::{TransferFeeAmount, TransferFeeConfig},
    BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022::state::{Account as SplAccount, Mint as SplMint};

declare_id!("GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz");

/// Share tokens always have 6 decimals.
pub const SHARE_DECIMALS: u8 = 6;
/// One whole share, in raw share units.
pub const ONE_SHARE: u64 = 1_000_000;
/// Upper bound on basket size, so `mint`/`redeem` fit in one transaction.
pub const MAX_COMPONENTS: usize = 8;
/// Creator fees are capped at 1%.
pub const MAX_CREATOR_FEE_BPS: u16 = 100;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
/// Basis-point denominator.
pub const BPS: u64 = 10_000;
/// Fixed-point scale of a plan's reference rate: raw share units per raw cash
/// unit, times 10^9.
pub const RATE_SCALE: u64 = 1_000_000_000;
/// A plan's auction band is capped at ±50% of its reference rate.
pub const MAX_BAND_BPS: u16 = 5_000;

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

        // The share mint must be a blank, basket-controlled, 6-decimal mint.
        let share_mint_info = ctx.accounts.share_mint.to_account_info();
        let mint_state = MintFields::parse(&share_mint_info.try_borrow_data()?)?;
        require!(
            mint_state.decimals == SHARE_DECIMALS,
            SheafError::ShareMintDecimals
        );
        require!(mint_state.supply == 0, SheafError::ShareMintNotEmpty);
        require!(
            mint_state.mint_authority == Some(basket_key),
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
                mint_info.owner == &token_program_key,
                SheafError::WrongTokenProgram
            );
            let decimals = MintFields::parse(&mint_info.try_borrow_data()?)?.decimals;

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

        emit!(BasketCreated {
            basket: basket_key,
            creator: basket.creator,
            share_mint: basket.share_mint,
            name,
            symbol,
            component_count: basket.component_count,
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

        // The creator's cut comes out of the shares issued, never out of the
        // vault, so backing per share is identical before and after.
        let fee_shares = creator_fee_on(shares, basket.creator_fee_bps)?;
        let net_shares = shares.checked_sub(fee_shares).ok_or(SheafError::MathOverflow)?;
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

        let shares_out = required_shares(
            order.start_shares,
            order.end_shares,
            order.start_ts,
            order.end_ts,
            now,
        )?;

        let basket = &ctx.accounts.basket;
        let basket_key = basket.key();
        let gross = gross_shares_for_net(shares_out, basket.creator_fee_bps)?;
        let fee_shares = gross.checked_sub(shares_out).ok_or(SheafError::MathOverflow)?;

        // Same deposit path, rounding and vault checks as `mint_shares`.
        let deposited = deposit_components(
            basket,
            &basket_key,
            ctx.remaining_accounts,
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
            ctx.accounts.order.to_account_info(),
            &ctx.accounts.escrow,
            ctx.accounts.cash_mint.to_account_info(),
            ctx.accounts.cash_mint.decimals,
            ctx.accounts.filler_cash_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
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
            // A plan that has since been closed is simply not updated.
            if plan_info.owner == &crate::ID && plan_info.lamports() > 0 {
                let mut plan = {
                    let data = plan_info.try_borrow_data()?;
                    Plan::try_deserialize(&mut &data[..])?
                };
                if plan.basket == order.basket
                    && plan.owner == order.buyer
                    && plan.cash_mint == order.cash_mint
                {
                    // A rate that does not fit (or rounds to zero) is not
                    // recorded; it must never block the buyer's fill.
                    let rate = shares_per_cash_e9(shares_out, order.cash_amount).unwrap_or(0);
                    if rate > 0 {
                        plan.ref_shares_per_cash_e9 = rate;
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
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let order: Order = (**ctx.accounts.order).clone();
        let by = ctx.accounts.caller.key();
        let expired = now > order.end_ts;
        require!(by == order.buyer || expired, SheafError::OrderNotExpired);

        let refunded = drain_and_close_escrow(
            &order,
            ctx.accounts.order.to_account_info(),
            &ctx.accounts.escrow,
            ctx.accounts.cash_mint.to_account_info(),
            ctx.accounts.cash_mint.decimals,
            ctx.accounts.buyer_cash_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            ctx.accounts.cash_token_program.to_account_info(),
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
    pub fn open_plan(
        ctx: Context<OpenPlan>,
        plan_id: u64,
        cash_per_run: u64,
        period_secs: i64,
        runs: u32,
        ref_shares_per_cash_e9: u64,
        band_bps: u16,
        auction_secs: i64,
    ) -> Result<()> {
        require!(cash_per_run > 0, SheafError::ZeroCash);
        require!(
            period_secs > 0 && runs > 0 && auction_secs > 0,
            SheafError::BadPlanSchedule
        );
        require!(ref_shares_per_cash_e9 > 0, SheafError::BadReferenceRate);
        require!(band_bps <= MAX_BAND_BPS, SheafError::BandTooWide);
        // The very first run must already be able to describe an auction.
        let (_, end) = plan_bounds(cash_per_run, ref_shares_per_cash_e9, band_bps)?;
        require!(end > 0, SheafError::PlanAmountTooSmall);
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
        });
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
        let (start_shares, end_shares) =
            plan_bounds(escrowed, plan.ref_shares_per_cash_e9, plan.band_bps)?;
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
        let cash_info = ctx.accounts.owner_cash_account.to_account_info();

        let revocable = cash_info.owner == &plan.cash_token_program && {
            let data = cash_info.try_borrow_data()?;
            match StateWithExtensions::<SplAccount>::unpack(&data) {
                Ok(state) => {
                    let delegate: Option<Pubkey> = state.base.delegate.into();
                    delegate == Some(plan_key) && state.base.owner == plan.owner
                }
                Err(_) => false,
            }
        };
        if revocable {
            token_interface::revoke(CpiContext::new(
                ctx.accounts.cash_token_program.to_account_info(),
                Revoke {
                    source: cash_info,
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ))?;
        }

        emit!(PlanClosed {
            plan: plan_key,
            owner: plan.owner,
            runs_done: plan.runs_total - plan.runs_left,
            runs_left: plan.runs_left,
            revoked: revocable,
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
        space = 8 + Plan::INIT_SPACE,
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
        seeds = [b"order", plan.basket.as_ref(), plan.owner.as_ref(), &nonce.to_le_bytes()],
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
        + 64; // headroom
}

/// A cash order on the desk. PDA: `["order", basket, buyer, nonce_le]`.
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
}

// ------------------------------------------------------------------ events

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

/// The handful of base-layout mint fields we care about. The layout is byte
/// identical for SPL Token and Token-2022; Token-2022 simply appends
/// extensions after it, which we deliberately ignore here.
struct MintFields {
    mint_authority: Option<Pubkey>,
    supply: u64,
    decimals: u8,
    freeze_authority: Option<Pubkey>,
}

impl MintFields {
    fn parse(data: &[u8]) -> Result<Self> {
        require!(data.len() >= 82, SheafError::MalformedMint);
        let read_key = |o: usize| -> Pubkey {
            let mut k = [0u8; 32];
            k.copy_from_slice(&data[o..o + 32]);
            Pubkey::new_from_array(k)
        };
        let mint_authority = if u32::from_le_bytes(data[0..4].try_into().unwrap()) == 1 {
            Some(read_key(4))
        } else {
            None
        };
        let supply = u64::from_le_bytes(data[36..44].try_into().unwrap());
        let decimals = data[44];
        let freeze_authority = if u32::from_le_bytes(data[46..50].try_into().unwrap()) == 1 {
            Some(read_key(50))
        } else {
            None
        };
        Ok(Self {
            mint_authority,
            supply,
            decimals,
            freeze_authority,
        })
    }
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
    order_info: AccountInfo<'info>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    cash_mint: AccountInfo<'info>,
    cash_decimals: u8,
    to: AccountInfo<'info>,
    rent_to: AccountInfo<'info>,
    cash_token_program: AccountInfo<'info>,
) -> Result<u64> {
    let nonce_bytes = order.nonce.to_le_bytes();
    let bump = [order.bump];
    let seeds: &[&[u8]] = &[
        b"order",
        order.basket.as_ref(),
        order.buyer.as_ref(),
        &nonce_bytes,
        &bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let escrow_info = escrow.to_account_info();

    let amount = escrow.amount;
    if amount > 0 {
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
/// window that has not already closed.
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
    require!(start_ts < end_ts && end_ts > now, SheafError::BadAuctionWindow);
    Ok(())
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

/// The creator fee on `shares`, exactly as `mint_shares` charges it.
pub fn creator_fee_on(shares: u64, fee_bps: u16) -> Result<u64> {
    mul_div_floor(shares, fee_bps as u64, BPS)
}

/// The smallest gross share count whose creator fee leaves exactly `net` for
/// the buyer. The net of `g` grows by 0 or 1 per unit of `g`, so the smallest
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
fn gross_for_transfer_fee(mint_info: &AccountInfo, target: u64, epoch: u64) -> Result<u64> {
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| SheafError::MalformedMint)?;
    match state.get_extension::<TransferFeeConfig>() {
        Ok(cfg) => cfg
            .get_epoch_fee(epoch)
            .calculate_pre_fee_amount(target)
            .ok_or_else(|| SheafError::MathOverflow.into()),
        Err(_) => Ok(target),
    }
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
}
