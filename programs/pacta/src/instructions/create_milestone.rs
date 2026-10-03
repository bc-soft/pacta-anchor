use anchor_lang::prelude::*;

use crate::errors::PactaError;
use crate::events::MilestoneCreated;
use crate::state::*;

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct CreateMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ PactaError::Unauthorized,
        seeds = [PROJECT_SEED, project.client.as_ref(), &project.seed.to_le_bytes()],
        bump = project.bump,
    )]
    pub project: Account<'info, Project>,

    #[account(
        init,
        payer = client,
        space = 8 + Milestone::INIT_SPACE,
        seeds = [MILESTONE_SEED, project.key().as_ref(), &[index]],
        bump,
    )]
    pub milestone: Account<'info, Milestone>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateMilestone>,
    index: u8,
    amount: u64,
    allocations: Vec<Allocation>,
) -> Result<()> {
    let project = &mut ctx.accounts.project;

    require!(project.status == ProjectStatus::Draft, PactaError::InvalidStatus);
    // Members sign the full set of terms; once anyone has signed, terms are frozen.
    require!(!project.any_accepted(), PactaError::ContractAlreadySigned);
    require_eq!(index, project.milestone_count, PactaError::InvalidMilestoneIndex);
    require!(amount > 0, PactaError::InvalidAmount);

    require!(
        !allocations.is_empty() && allocations.len() <= MAX_MEMBERS,
        PactaError::InvalidAllocationCount
    );
    let mut bps_sum: u32 = 0;
    for (i, allocation) in allocations.iter().enumerate() {
        require!(allocation.bps > 0, PactaError::ZeroBps);
        require!(project.is_member(&allocation.wallet), PactaError::AllocationNotMember);
        require!(
            !allocations[..i].iter().any(|a| a.wallet == allocation.wallet),
            PactaError::DuplicateAllocation
        );
        bps_sum += allocation.bps as u32;
    }
    require_eq!(bps_sum, BPS_DENOMINATOR as u32, PactaError::InvalidBpsSum);

    project.milestone_count = project
        .milestone_count
        .checked_add(1)
        .ok_or(PactaError::TooManyMilestones)?;

    let milestone = &mut ctx.accounts.milestone;
    milestone.project = project.key();
    milestone.index = index;
    milestone.amount = amount;
    milestone.status = MilestoneStatus::Draft;
    milestone.allocations = allocations;
    milestone.dispute = None;
    milestone.bump = ctx.bumps.milestone;

    emit!(MilestoneCreated {
        project: project.key(),
        milestone: milestone.key(),
        index,
        amount,
    });
    Ok(())
}
