use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PactaError;
use crate::events::MilestoneAccepted;
use crate::payout;
use crate::state::*;

/// Remaining accounts: the team's token accounts (project mint), one per allocation,
/// in the same order as `milestone.allocations`.
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct AcceptMilestone<'info> {
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ PactaError::Unauthorized,
        has_one = mint @ PactaError::MintMismatch,
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

    pub token_program: Program<'info, Token>,
}

/// The moment the intermediary disappears: the client's approval triggers the split
/// agreed before work started, paid straight from escrow to every member's wallet.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AcceptMilestone<'info>>,
    index: u8,
) -> Result<()> {
    require!(
        ctx.accounts.milestone.status == MilestoneStatus::Submitted,
        PactaError::InvalidStatus
    );

    let amount = ctx.accounts.milestone.amount;
    let allocations = ctx.accounts.milestone.allocations.clone();
    payout::distribute_to_team(
        &ctx.accounts.project,
        ctx.accounts.milestone.key(),
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        ctx.remaining_accounts,
        &allocations,
        amount,
    )?;

    ctx.accounts.milestone.status = MilestoneStatus::Paid;
    ctx.accounts.project.close_milestone()?;

    emit!(MilestoneAccepted {
        project: ctx.accounts.project.key(),
        milestone: ctx.accounts.milestone.key(),
        index,
        amount,
    });
    Ok(())
}
