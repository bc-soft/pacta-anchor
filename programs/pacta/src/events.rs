use anchor_lang::prelude::*;

use crate::state::Resolution;

#[event]
pub struct ProjectCreated {
    pub project: Pubkey,
    pub client: Pubkey,
    pub mint: Pubkey,
    pub arbiter: Option<Pubkey>,
    pub member_count: u8,
}

#[event]
pub struct MilestoneCreated {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub amount: u64,
}

#[event]
pub struct ContractAccepted {
    pub project: Pubkey,
    pub member: Pubkey,
    /// True when this signature activated the project.
    pub all_accepted: bool,
}

#[event]
pub struct MilestoneFunded {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub amount: u64,
}

#[event]
pub struct MilestoneStarted {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub member: Pubkey,
}

#[event]
pub struct MilestoneSubmitted {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub member: Pubkey,
}

#[event]
pub struct ChangesRequested {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
}

#[event]
pub struct MilestoneAccepted {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub amount: u64,
}

#[event]
pub struct PaymentDistributed {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeOpened {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub opened_by: Pubkey,
}

#[event]
pub struct DisputeResolved {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub resolution: Resolution,
    pub team_amount: u64,
    pub client_amount: u64,
}

#[event]
pub struct MilestoneCancelled {
    pub project: Pubkey,
    pub milestone: Pubkey,
    pub index: u8,
    pub refunded: u64,
}
