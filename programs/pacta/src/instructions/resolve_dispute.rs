use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PactaError;
use crate::events::DisputeResolved;
use crate::payout;
use crate::state::*;

/// Remaining accounts: the team's token accounts in allocation order
/// (may be omitted for `Client100`, where the team receives nothing).
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ResolveDispute<'info> {
    pub arbiter: Signer<'info>,

    #[account(
        mut,
        has_one = mint @ PactaError::MintMismatch,
        constraint = project.arbiter == Some(arbiter.key()) @ PactaError::Unauthorized,
        seeds = [PROJECT_SEED, project.client.as_ref(), &project.seed.to_le_bytes()],
        bump = project.bump,
    )]
    pub project: Account<'info, Project>,

    #[account(
        mut,
        has_one = project,
        seeds = [MILESTONE_SEED, project.key().as_ref(), &[index]],
        bump = milestone.bump,
    )]
    pub milestone: Account<'info, Milestone>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, project.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = project,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: only used as the authority of `client_ata`; must be the project's client.
    #[account(address = project.client @ PactaError::Unauthorized)]
    pub client: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// The arbiter picks one of a closed set of outcomes. Funds can only go to the
/// milestone's allocation wallets and back to the client, never to the arbiter.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ResolveDispute<'info>>,
    index: u8,
    resolution: Resolution,
) -> Result<()> {
    require!(
        ctx.accounts.milestone.status == MilestoneStatus::Disputed,
        PactaError::InvalidStatus
    );

    let amount = ctx.accounts.milestone.amount;
    let team_amount = payout::bps_of(amount, resolution.team_bps())?;
    let client_amount = amount.checked_sub(team_amount).ok_or(PactaError::MathOverflow)?;
    let allocations = ctx.accounts.milestone.allocations.clone();

    payout::distribute_to_team(
        &ctx.accounts.project,
        ctx.accounts.milestone.key(),
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        ctx.remaining_accounts,
        &allocations,
        team_amount,
    )?;
    payout::transfer_from_vault(
        &ctx.accounts.project,
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        ctx.accounts.client_ata.to_account_info(),
        client_amount,
    )?;

    let milestone = &mut ctx.accounts.milestone;
    milestone.status = if resolution == Resolution::Client100 {
        MilestoneStatus::Cancelled
    } else {
        MilestoneStatus::Paid
    };
    if let Some(dispute) = milestone.dispute.as_mut() {
        dispute.resolution = Some(resolution);
    }
    let milestone_key = milestone.key();
    ctx.accounts.project.close_milestone()?;

    emit!(DisputeResolved {
        project: ctx.accounts.project.key(),
        milestone: milestone_key,
        index,
        resolution,
        team_amount,
        client_amount,
    });
    Ok(())
}
