use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::PactaError;
use crate::events::MilestoneFunded;
use crate::state::*;

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct FundMilestone<'info> {
    pub client: Signer<'info>,

    #[account(
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
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_ata: Account<'info, TokenAccount>,

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

pub fn handler(ctx: Context<FundMilestone>, index: u8) -> Result<()> {
    require!(ctx.accounts.project.status == ProjectStatus::Active, PactaError::InvalidStatus);
    require!(ctx.accounts.milestone.status == MilestoneStatus::Draft, PactaError::InvalidStatus);

    // Always exactly the agreed amount; never a caller-provided value.
    let amount = ctx.accounts.milestone.amount;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.client_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.client.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let milestone = &mut ctx.accounts.milestone;
    milestone.status = MilestoneStatus::Funded;

    emit!(MilestoneFunded {
        project: ctx.accounts.project.key(),
        milestone: milestone.key(),
        index,
        amount,
    });
    Ok(())
}
