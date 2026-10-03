//! Status-only transitions (no token movement): start, submit, request changes, open dispute.
//! Each handler checks who may sign and from which status the transition is allowed.

use anchor_lang::prelude::*;

use crate::errors::PactaError;
use crate::events::{ChangesRequested, DisputeOpened, MilestoneStarted, MilestoneSubmitted};
use crate::state::*;

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct MilestoneAction<'info> {
    pub signer: Signer<'info>,

    #[account(
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
}

/// Member: Funded | ChangesRequested -> InProgress.
/// Once started, the client can no longer cancel and take the money back.
pub fn start(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
    let member = ctx.accounts.signer.key();
    ctx.accounts.project.require_member(&member)?;

    let milestone = &mut ctx.accounts.milestone;
    require!(
        matches!(milestone.status, MilestoneStatus::Funded | MilestoneStatus::ChangesRequested),
        PactaError::InvalidStatus
    );
    milestone.status = MilestoneStatus::InProgress;

    emit!(MilestoneStarted {
        project: ctx.accounts.project.key(),
        milestone: milestone.key(),
        index,
        member,
    });
    Ok(())
}

/// Member: Funded | InProgress | ChangesRequested -> Submitted.
pub fn submit(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
    let member = ctx.accounts.signer.key();
    ctx.accounts.project.require_member(&member)?;

    let milestone = &mut ctx.accounts.milestone;
    require!(
        matches!(
            milestone.status,
            MilestoneStatus::Funded | MilestoneStatus::InProgress | MilestoneStatus::ChangesRequested
        ),
        PactaError::InvalidStatus
    );
    milestone.status = MilestoneStatus::Submitted;

    emit!(MilestoneSubmitted {
        project: ctx.accounts.project.key(),
        milestone: milestone.key(),
        index,
        member,
    });
    Ok(())
}

/// Client: Submitted -> ChangesRequested. Funds stay in the vault.
pub fn request_changes(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
    ctx.accounts.project.require_client(&ctx.accounts.signer.key())?;

    let milestone = &mut ctx.accounts.milestone;
    require!(milestone.status == MilestoneStatus::Submitted, PactaError::InvalidStatus);
    milestone.status = MilestoneStatus::ChangesRequested;

    emit!(ChangesRequested {
        project: ctx.accounts.project.key(),
        milestone: milestone.key(),
        index,
    });
    Ok(())
}

/// Client or member: Submitted | ChangesRequested | InProgress -> Disputed.
/// InProgress is included so the client can recover funds through the arbiter
/// when the team starts a milestone and then disappears.
pub fn open_dispute(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let project = &ctx.accounts.project;
    require!(
        signer == project.client || project.is_member(&signer),
        PactaError::Unauthorized
    );
    require!(project.arbiter.is_some(), PactaError::ArbiterRequired);

    let milestone = &mut ctx.accounts.milestone;
    require!(
        matches!(
            milestone.status,
            MilestoneStatus::Submitted | MilestoneStatus::ChangesRequested | MilestoneStatus::InProgress
        ),
        PactaError::InvalidStatus
    );
    milestone.status = MilestoneStatus::Disputed;
    milestone.dispute = Some(Dispute { opened_by: signer, resolution: None });

    emit!(DisputeOpened {
        project: project.key(),
        milestone: milestone.key(),
        index,
        opened_by: signer,
    });
    Ok(())
}
