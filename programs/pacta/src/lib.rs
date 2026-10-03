use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod payout;
pub mod state;

use instructions::*;
use state::{Allocation, MemberInput, Resolution};

declare_id!("AgSfAvkXWBugaYg768AAZdpUT3oNYkx7JQGmZTrUwHWK");

/// Pacta: escrow for ad-hoc freelance teams.
/// Lifecycle: CREATE -> AGREE -> FUND -> WORK -> ACCEPT -> SPLIT.
/// There is no admin instruction: funds leave the vault only through
/// `accept_milestone`, `resolve_dispute` and `cancel_unstarted_milestone`.
#[program]
pub mod pacta {
    use super::*;

    // CREATE

    pub fn create_project(
        ctx: Context<CreateProject>,
        seed: u64,
        mint: Pubkey,
        arbiter: Option<Pubkey>,
        members: Vec<MemberInput>,
    ) -> Result<()> {
        instructions::create_project::handler(ctx, seed, mint, arbiter, members)
    }

    pub fn create_milestone(
        ctx: Context<CreateMilestone>,
        index: u8,
        amount: u64,
        allocations: Vec<Allocation>,
    ) -> Result<()> {
        instructions::create_milestone::handler(ctx, index, amount, allocations)
    }

    // AGREE

    pub fn accept_contract(ctx: Context<AcceptContract>) -> Result<()> {
        instructions::accept_contract::handler(ctx)
    }

    // FUND

    pub fn fund_milestone(ctx: Context<FundMilestone>, index: u8) -> Result<()> {
        instructions::fund_milestone::handler(ctx, index)
    }

    // WORK

    pub fn start_milestone(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
        instructions::milestone_status::start(ctx, index)
    }

    pub fn submit_milestone(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
        instructions::milestone_status::submit(ctx, index)
    }

    pub fn request_changes(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
        instructions::milestone_status::request_changes(ctx, index)
    }

    // ACCEPT -> SPLIT

    pub fn accept_milestone<'info>(
        ctx: Context<'_, '_, 'info, 'info, AcceptMilestone<'info>>,
        index: u8,
    ) -> Result<()> {
        instructions::accept_milestone::handler(ctx, index)
    }

    // DISPUTES AND REFUNDS

    pub fn open_dispute(ctx: Context<MilestoneAction>, index: u8) -> Result<()> {
        instructions::milestone_status::open_dispute(ctx, index)
    }

    pub fn resolve_dispute<'info>(
        ctx: Context<'_, '_, 'info, 'info, ResolveDispute<'info>>,
        index: u8,
        resolution: Resolution,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, index, resolution)
    }

    pub fn cancel_unstarted_milestone(
        ctx: Context<CancelUnstartedMilestone>,
        index: u8,
    ) -> Result<()> {
        instructions::cancel_unstarted_milestone::handler(ctx, index)
    }
}
