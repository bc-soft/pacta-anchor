use anchor_lang::prelude::*;

use crate::errors::PactaError;
use crate::events::ContractAccepted;
use crate::state::*;

#[derive(Accounts)]
pub struct AcceptContract<'info> {
    pub member: Signer<'info>,

    #[account(
        mut,
        seeds = [PROJECT_SEED, project.client.as_ref(), &project.seed.to_le_bytes()],
        bump = project.bump,
    )]
    pub project: Account<'info, Project>,
}

pub fn handler(ctx: Context<AcceptContract>) -> Result<()> {
    let signer = ctx.accounts.member.key();
    let project = &mut ctx.accounts.project;

    require!(project.status == ProjectStatus::Draft, PactaError::InvalidStatus);
    require!(project.milestone_count > 0, PactaError::NoMilestones);

    let member = project
        .members
        .iter_mut()
        .find(|m| m.wallet == signer)
        .ok_or(PactaError::Unauthorized)?;
    require!(!member.accepted, PactaError::AlreadyAccepted);
    member.accepted = true;

    let all_accepted = project.all_accepted();
    if all_accepted {
        project.status = ProjectStatus::Active;
    }

    emit!(ContractAccepted {
        project: project.key(),
        member: signer,
        all_accepted,
    });
    Ok(())
}
