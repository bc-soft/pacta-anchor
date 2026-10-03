use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PactaError;
use crate::events::MilestoneCancelled;
use crate::payout;
use crate::state::*;

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct CancelUnstartedMilestone<'info> {
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

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Client: Draft | Funded -> Cancelled, refunding the full amount if it was funded.
/// Not allowed once the team started or submitted work.
pub fn handler(ctx: Context<CancelUnstartedMilestone>, index: u8) -> Result<()> {
    let status = ctx.accounts.milestone.status;
    require!(
        matches!(status, MilestoneStatus::Draft | MilestoneStatus::Funded),
        PactaError::InvalidStatus
    );

    let refunded = if status == MilestoneStatus::Funded {
        ctx.accounts.milestone.amount
    } else {
        0
    };
    payout::transfer_from_vault(
        &ctx.accounts.project,
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        ctx.accounts.client_ata.to_account_info(),
        refunded,
    )?;

    ctx.accounts.milestone.status = MilestoneStatus::Cancelled;
    ctx.accounts.project.close_milestone()?;

    emit!(MilestoneCancelled {
        project: ctx.accounts.project.key(),
        milestone: ctx.accounts.milestone.key(),
        index,
        refunded,
    });
    Ok(())
}
